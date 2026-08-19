// apps/api/src/use-cases/customers/InitiatePasswordResetUseCase.ts
import { Customer } from "@api/domain/entities/Customer";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import {
  CustomerAuthenticationMetadata,
  PasswordResetTokenIssueResult,
} from "@api/domain/shared/contracts";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import { INotificationService } from "@api/domain/shared/notifications";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: initiate a password reset flow for a customer.
 *
 * Responsibilities:
 * - Validate and normalize input.
 * - Fail silently when the email is not found to prevent enumeration.
 * - Generate a time-limited reset token via the token service.
 * - Persist reset metadata on the customer record (hashed token or token id + expiry).
 * - Send a password reset notification (best-effort).
 * - Emit a non-blocking audit log entry recording the initiation attempt.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 *
 * L8 PART 3 (direct-sync RETAINED — NOT outbox-migrated):
 * This use case deliberately keeps its notification path synchronous rather than
 * routing through the notification outbox. The `password_reset` intent carries
 * the RAW single-use token — the adapter cannot compose the reset link without
 * it, and the token is not retrievable after hashing. Persisting that intent
 * into the outbox (or a job payload) would durably store a credential-bearing
 * secret in the async pipeline — a security risk. Invariants that hold:
 *   1. The notification runs strictly AFTER the reset metadata persistence
 *      attempt — never inside a DB transaction.
 *   2. A notification failure NEVER rolls back committed state (best-effort;
 *      the failure is logged and audited).
 *   3. The raw token NEVER touches the outbox, queue payloads, or logs — only
 *      the customer record carries token metadata (id/hash), never the token.
 */
export interface InitiatePasswordResetInput {
  email: string;
  actorId?: string;
  ipAddress?: string;
  userAgent?: string;
  // Optional TTL override in seconds (useful for tests/admin)
  tokenTtlSeconds?: number;
}

export class InitiatePasswordResetUseCase {
  private static readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  private static readonly DEFAULT_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

  constructor(
    private readonly customerRepository: ICustomerRepository,
    private readonly tokenService: ITokenService,
    private readonly notificationService: INotificationService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: InitiatePasswordResetInput): Promise<void> {
    const rawEmail = (input.email ?? "").trim();
    const email = rawEmail.toLowerCase();
    const actorId = (input.actorId ?? "").trim() || "system";
    const ipAddress = (input.ipAddress ?? "").trim() || "unknown";
    const userAgent = (input.userAgent ?? "").trim() || "unknown";
    const tokenTtlSeconds = Number.isFinite(input.tokenTtlSeconds ?? NaN)
      ? Math.max(60, Math.floor(input.tokenTtlSeconds!))
      : InitiatePasswordResetUseCase.DEFAULT_TOKEN_TTL_SECONDS;

    // --- Validate input
    if (!email) {
      throw new DomainError("VALIDATION_ERROR", "Email is required.");
    }
    if (!InitiatePasswordResetUseCase.EMAIL_REGEX.test(email)) {
      // Still treat as validation error; do not proceed with repository calls
      throw new DomainError("VALIDATION_ERROR", "Email format is invalid.");
    }

    // --- Load customer (do not reveal existence to caller)
    let customer: Customer | null = null;
    try {
      customer = await this.customerRepository.findByEmail(email);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to fetch customer while initiating password reset",
        { err, email },
      );
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while initiating password reset.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while initiating password reset.",
        );
      }
      // Generic mapping
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to initiate password reset.",
      );
    }

    // --- If customer not found, fail silently (prevent email enumeration)
    if (!customer) {
      try {
        await this.auditLogService.logAction(
          actorId,
          "PASSWORD_RESET_INITIATED_UNKNOWN_EMAIL",
          {
            auditId: this.idGenerator.generate(),
            email,
            ipAddress,
            userAgent,
            notedAt: new Date().toISOString(),
          },
        );
      } catch {
        /* swallow audit errors */
      }
      // Intentionally return without indicating whether the email exists
      return;
    }

    // --- Generate reset token (tokenService decides format and signing)
    let resetToken: string;
    let tokenId: string | undefined;
    try {
      // tokenService may return a token string or an object { token, id, expiresAt }
      const tokenResult = await this.tokenService.generatePasswordResetToken(
        customer.id,
        { ttlSeconds: tokenTtlSeconds },
      );
      if (typeof tokenResult === "string") {
        resetToken = tokenResult;
        tokenId = undefined;
      } else if (tokenResult && typeof tokenResult === "object") {
        const typedTokenResult = tokenResult as PasswordResetTokenIssueResult;
        resetToken = String(typedTokenResult.token ?? "");
        tokenId = typedTokenResult.id ?? undefined;
      } else {
        this.logger.error(
          "Token service returned unexpected shape for password reset token",
          { email, tokenResult },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to generate password reset token.",
        );
      }

      if (!resetToken) {
        this.logger.error(
          "Token service returned empty token for password reset",
          { email },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to generate password reset token.",
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        "Token service error while generating password reset token",
        { err, email },
      );
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to generate password reset token.",
      );
    }

    // --- Persist reset metadata on customer record (best practice: store token id or hashed token)
    try {
      const expiresAt = new Date(
        Date.now() + tokenTtlSeconds * 1000,
      ).toISOString();

      // Prefer storing a token id or hashed token rather than raw token
      const resetMetadata: CustomerAuthenticationMetadata = {
        passwordResetTokenId: tokenId ?? null,
        passwordResetRequestedAt: new Date().toISOString(),
        passwordResetExpiresAt: expiresAt,
        // Optionally store a fingerprint for rate limiting / verification
        passwordResetRequestIp: ipAddress,
      };

      // If tokenService provided a token id, store it; otherwise store a one-way hash via tokenService if available
      if (!tokenId && typeof this.tokenService.hashToken === "function") {
        // Hash the token before persisting
        resetMetadata.passwordResetTokenHash = await this.tokenService.hashToken(
          resetToken,
        );
      } else if (!tokenId) {
        // As a fallback, do not persist raw token; persist only metadata and rely on tokenService to validate token on use
        resetMetadata.passwordResetTokenHash = null;
      }

      await this.customerRepository.updateAuthenticationMetadata(
        customer.id,
        resetMetadata,
      );
    } catch (err: unknown) {
      this.logger.error(
        "Failed to persist password reset metadata on customer",
        { err, customerId: customer.id, email },
      );
      // Do not block sending the email if persistence fails; continue but surface a warning in audit
      try {
        await this.auditLogService.logAction(
          actorId,
          "PASSWORD_RESET_METADATA_PERSIST_FAILED",
          {
            auditId: this.idGenerator.generate(),
            customerId: customer.id,
            email,
            notedAt: new Date().toISOString(),
          },
        );
      } catch {
        /* swallow audit errors */
      }
    }

    // --- Send password reset notification (direct-sync, best-effort)
    try {
      // L8 PART 3 (direct-sync retained): the RAW token is required here — the
      // adapter cannot render the reset link without it. For this reason the
      // notification is NOT routed through the notification outbox: storing the
      // intent would persist a credential-bearing secret in the async pipeline.
      // The notification runs AFTER the reset metadata was persisted (never
      // inside a DB transaction) and can never roll back state. Recipient is
      // the authoritative customer.email; token + TTL come from the token service.
      await this.notificationService.sendPasswordReset({
        recipient: {
          email: customer.email,
          name:
            [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
            null,
        },
        customerId: customer.id,
        token: resetToken,
        expiresInSeconds: tokenTtlSeconds,
        requestedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      this.logger.warn(
        "Notification service failed to send password reset email",
        { err, customerId: customer.id, email },
      );
      // Do not throw; sending email is best-effort. Record in audit log below.
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId,
        "PASSWORD_RESET_INITIATED",
        {
          auditId: this.idGenerator.generate(),
          customerId: customer.id,
          email,
          tokenId: tokenId ?? "",
          tokenTtlSeconds: String(tokenTtlSeconds),
          ipAddress,
          userAgent,
          initiatedAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for password reset initiation", {
        err: auditErr,
        customerId: customer.id,
        email,
      });
    }

    this.logger.info("Password reset initiated", {
      customerId: customer.id,
      email,
    });
    return;
  }
}
