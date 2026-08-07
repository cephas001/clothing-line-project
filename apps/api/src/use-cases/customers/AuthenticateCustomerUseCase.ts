// apps/api/src/use-cases/customers/AuthenticateCustomerUseCase.ts
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IHashingService } from "@api/domain/interfaces/services/IHashingService";
import { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { Customer } from "@api/domain/entities/Customer";
import { CustomerAuthenticationMetadata } from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: authenticate a customer and issue an access token.
 *
 * Responsibilities:
 * - Validate and normalize inputs (email, password).
 * - Protect against brute-force by tracking failed attempts (best-effort).
 * - Delegate password verification to the hashing service.
 * - Generate an auth token via the token service.
 * - Persist authentication-related metadata (lastLoginAt, failedAttempts) when appropriate.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the authentication attempt and outcome.
 * - Log structured events and failures for observability.
 */
export interface AuthenticateCustomerInput {
  email: string;
  passwordRaw: string;
  actorId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export class AuthenticateCustomerUseCase {
  private static readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  private static readonly MAX_FAILED_ATTEMPTS = 10;
  private static readonly LOCKOUT_THRESHOLD = 5;
  private static readonly LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  constructor(
    private readonly customerRepository: ICustomerRepository,
    private readonly hashingService: IHashingService,
    private readonly tokenService: ITokenService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(
    input: AuthenticateCustomerInput,
  ): Promise<{ accessToken: string }> {
    const rawEmail = (input.email ?? "").trim();
    const email = rawEmail.toLowerCase();
    const passwordRaw = input.passwordRaw ?? "";
    const actorId = (input.actorId ?? "").trim() || "system";
    const ipAddress = (input.ipAddress ?? "").trim() || "unknown";
    const userAgent = (input.userAgent ?? "").trim() || "unknown";

    // --- Validate inputs
    if (!email) {
      throw new DomainError("VALIDATION_ERROR", "Email is required.");
    }
    if (!AuthenticateCustomerUseCase.EMAIL_REGEX.test(email)) {
      throw new DomainError("VALIDATION_ERROR", "Email format is invalid.");
    }
    if (!passwordRaw || typeof passwordRaw !== "string") {
      throw new DomainError("VALIDATION_ERROR", "Password is required.");
    }

    // --- Load customer
    let customer: Customer | null;
    try {
      customer = await this.customerRepository.findByEmail(email);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to fetch customer by email during authentication",
        { err, email },
      );
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while fetching customer.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while fetching customer.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch customer.");
    }

    // If customer not found, avoid revealing which part failed (timing differences aside)
    if (!customer) {
      // Audit failed attempt (non-blocking)
      try {
        await this.auditLogService.logAction(actorId, "AUTHENTICATION_FAILED", {
          auditId: this.idGenerator.generate(),
          email,
          reason: "INVALID_CREDENTIALS",
          ipAddress,
          userAgent,
          attemptedAt: new Date().toISOString(),
        });
      } catch {
        /* swallow audit errors */
      }

      throw new DomainError(
        "INVALID_CREDENTIALS",
        "Invalid email or password.",
      );
    }

    // --- Check account state (locked, disabled)
    const now = Date.now();
    const failedAttempts = Number(customer.failed ?? 0);
    const lastFailedAt = customer.lastFailedAt
      ? new Date(customer.lastFailedAt).getTime()
      : 0;
    const lockUntil = customer.lockUntil
      ? new Date(customer.lockUntil).getTime()
      : 0;

    if (customer.disabled) {
      this.logger.info("Authentication attempt for disabled account", {
        customerId: customer.id,
        email,
      });
      throw new DomainError(
        "ACCOUNT_DISABLED",
        "This account has been disabled.",
      );
    }

    if (lockUntil && lockUntil > now) {
      this.logger.info("Authentication attempt for locked account", {
        customerId: customer.id,
        email,
        lockUntil: new Date(lockUntil).toISOString(),
      });
      throw new DomainError(
        "ACCOUNT_LOCKED",
        "Account temporarily locked due to multiple failed login attempts.",
      );
    }

    // --- Verify password
    let isPasswordValid = false;
    try {
      if (!customer.passwordHash) {
        isPasswordValid = false;
      } else {
        isPasswordValid = await this.hashingService.compare(
          passwordRaw,
          customer.passwordHash,
        );
      }
    } catch (err: unknown) {
      this.logger.error("Hashing service error during password comparison", {
        err,
        customerId: customer.id,
        email,
      });
      throw new DomainError("INTERNAL_ERROR", "Failed to verify credentials.");
    }

    // --- Handle invalid password: increment failed attempts and possibly lock account
    if (!isPasswordValid) {
      const newFailedAttempts = Math.min(
        AuthenticateCustomerUseCase.MAX_FAILED_ATTEMPTS,
        failedAttempts + 1,
      );
      const updates: CustomerAuthenticationMetadata = {
        failedAttempts: newFailedAttempts,
        lastFailedAt: new Date().toISOString(),
      };

      // If within lockout window and threshold exceeded, set lockUntil
      const withinWindow =
        lastFailedAt &&
        now - lastFailedAt <= AuthenticateCustomerUseCase.LOCKOUT_WINDOW_MS;
      if (
        (withinWindow &&
          newFailedAttempts >= AuthenticateCustomerUseCase.LOCKOUT_THRESHOLD) ||
        newFailedAttempts >= AuthenticateCustomerUseCase.MAX_FAILED_ATTEMPTS
      ) {
        // Lock account for the lockout window
        updates.lockUntil = new Date(
          now + AuthenticateCustomerUseCase.LOCKOUT_WINDOW_MS,
        ).toISOString();
      }

      try {
        await this.customerRepository.updateAuthenticationMetadata(
          customer.id,
          updates,
        );
      } catch (err: any) {
        this.logger.warn(
          "Failed to persist failed authentication metadata (non-blocking)",
          { err, customerId: customer.id, email },
        );
      }

      // Audit failed attempt (non-blocking)
      try {
        await this.auditLogService.logAction(actorId, "AUTHENTICATION_FAILED", {
          auditId: this.idGenerator.generate(),
          customerId: customer.id,
          email,
          reason: "INVALID_CREDENTIALS",
          failedAttempts: String(newFailedAttempts),
          ipAddress,
          userAgent,
          attemptedAt: new Date().toISOString(),
        });
      } catch {
        /* swallow audit errors */
      }

      throw new DomainError(
        "INVALID_CREDENTIALS",
        "Invalid email or password.",
      );
    }

    // --- Successful authentication: reset failed attempts, update lastLoginAt
    try {
      const metadataUpdates: CustomerAuthenticationMetadata = {
        failedAttempts: 0,
        lastFailedAt: null,
        lockUntil: null,
        lastLoginAt: new Date().toISOString(),
      };
      await this.customerRepository.updateAuthenticationMetadata(
        customer.id,
        metadataUpdates,
      );
    } catch (err: unknown) {
      this.logger.warn(
        "Failed to persist successful authentication metadata (non-blocking)",
        { err, customerId: customer.id, email },
      );
    }

    // --- Generate access token
    let accessToken: string;
    try {
      accessToken = await this.tokenService.generateAuthToken({
        customerId: customer.id,
        roles: customer.roles ?? [],
        email: customer.email,
      });
      if (!accessToken || typeof accessToken !== "string") {
        this.logger.error("Token service returned invalid token", {
          customerId: customer.id,
          email,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to generate access token.",
        );
      }
    } catch (err: unknown) {
      this.logger.error("Token service error while generating auth token", {
        err,
        customerId: customer.id,
        email,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to generate access token.",
      );
    }

    // --- Audit successful authentication (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId,
        "AUTHENTICATION_SUCCEEDED",
        {
          auditId: this.idGenerator.generate(),
          customerId: customer.id,
          email,
          ipAddress,
          userAgent,
          issuedAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for successful authentication", {
        err: auditErr,
        customerId: customer.id,
        email,
      });
    }

    this.logger.info("Customer authenticated successfully", {
      customerId: customer.id,
      email,
      ipAddress,
    });
    return { accessToken };
  }
}
