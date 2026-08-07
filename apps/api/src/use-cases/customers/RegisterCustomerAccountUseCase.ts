// apps/api/src/use-cases/customers/RegisterCustomerAccountUseCase.ts
import { Customer } from "@api/domain/entities/Customer";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IHashingService } from "@api/domain/interfaces/services/IHashingService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: register a new customer account.
 *
 * Responsibilities:
 * - Validate and normalize inputs (email, password, names).
 * - Enforce basic password policy and email format.
 * - Ensure uniqueness of email (idempotent check).
 * - Delegate password hashing to the hashing service (infrastructure).
 * - Persist the new Customer entity and emit a non-blocking audit log entry.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Log structured events and failures for observability.
 */
export interface RegisterCustomerAccountInput {
  email: string;
  passwordRaw: string;
  firstName: string;
  lastName: string;
  actorId?: string;
}

export class RegisterCustomerAccountUseCase {
  private static readonly MIN_PASSWORD_LENGTH = 8;
  private static readonly MAX_NAME_LENGTH = 256;
  private static readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  constructor(
    private readonly customerRepository: ICustomerRepository,
    private readonly hashingService: IHashingService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: RegisterCustomerAccountInput): Promise<Customer> {
    const rawEmail = (input.email ?? "").trim();
    const email = rawEmail.toLowerCase();
    const passwordRaw = input.passwordRaw ?? "";
    const firstName = (input.firstName ?? "").trim();
    const lastName = (input.lastName ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Validate inputs
    if (!email) {
      throw new DomainError("VALIDATION_ERROR", "Email is required.");
    }
    if (!RegisterCustomerAccountUseCase.EMAIL_REGEX.test(email)) {
      throw new DomainError("VALIDATION_ERROR", "Email format is invalid.");
    }
    if (
      !passwordRaw ||
      typeof passwordRaw !== "string" ||
      passwordRaw.length < RegisterCustomerAccountUseCase.MIN_PASSWORD_LENGTH
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Password must be at least ${RegisterCustomerAccountUseCase.MIN_PASSWORD_LENGTH} characters long.`,
      );
    }
    if (!firstName) {
      throw new DomainError("VALIDATION_ERROR", "firstName is required.");
    }
    if (!lastName) {
      throw new DomainError("VALIDATION_ERROR", "lastName is required.");
    }
    if (
      firstName.length > RegisterCustomerAccountUseCase.MAX_NAME_LENGTH ||
      lastName.length > RegisterCustomerAccountUseCase.MAX_NAME_LENGTH
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Names cannot exceed ${RegisterCustomerAccountUseCase.MAX_NAME_LENGTH} characters.`,
      );
    }

    // --- Check for existing customer (uniqueness)
    try {
      const existingCustomer = await this.customerRepository.findByEmail(email);
      if (existingCustomer) {
        this.logger.info("Attempt to register an already existing customer", {
          email,
        });
        throw new DomainError(
          "CUSTOMER_ALREADY_EXISTS",
          "A customer with this email is already registered.",
        );
      }
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to check existing customer by email", {
        err,
        email,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while checking existing customer.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while checking existing customer.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to verify existing customer.",
      );
    }

    // --- Hash password
    let passwordHash: string;
    try {
      passwordHash = await this.hashingService.hash(passwordRaw);
      if (!passwordHash || typeof passwordHash !== "string") {
        this.logger.error("Hashing service returned invalid hash", { email });
        throw new DomainError("INTERNAL_ERROR", "Failed to hash password.");
      }
    } catch (err: any) {
      this.logger.error("Hashing service error while hashing password", {
        err,
        email,
      });
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError("INTERNAL_ERROR", "Hashing operation timed out.");
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to hash password.");
    }

    // --- Build customer entity
    const customerId = this.idGenerator.generate();
    const nowIso = new Date().toISOString();
    const newCustomer = new Customer({
      id: customerId,
      email,
      passwordHash,
      firstName,
      lastName,
      registeredAt: nowIso,
    });

    // --- Persist customer
    try {
      await this.customerRepository.save(newCustomer);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist new customer", {
        err,
        email,
        customerId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // Race: another process created the customer concurrently
        throw new DomainError(
          "CUSTOMER_ALREADY_EXISTS",
          "A customer with this email is already registered.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving customer.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving customer.",
        );
      }

      throw new DomainError("INTERNAL_ERROR", "Failed to register customer.");
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "CUSTOMER_REGISTERED", {
        auditId: this.idGenerator.generate(),
        customerId,
        email,
        registeredAt: nowIso,
      });
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for customer registration", {
        err: auditErr,
        customerId,
        email,
      });
    }

    this.logger.info("Customer registered successfully", { customerId, email });
    return newCustomer;
  }
}
