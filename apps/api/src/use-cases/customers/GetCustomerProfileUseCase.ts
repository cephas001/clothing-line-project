// apps/api/src/use-cases/customers/GetCustomerProfileUseCase.ts

import { Customer } from "@api/domain/entities/Customer";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: retrieve the authenticated customer's public profile (read-only).
 *
 * Responsibilities:
 * - Validate and normalize the customerId input. The customerId is ALWAYS the
 *   JWT-derived actor identity — never read from a request body.
 * - Load the customer aggregate through the repository abstraction.
 * - Map repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the read.
 * - Return the Customer aggregate for the transport boundary to project; the
 *   projection layer strips backend-private auth state (password hash, reset
 *   tokens, security counters).
 */
export interface GetCustomerProfileInput {
  customerId: string;
  /** The JWT-derived actor identity; the ONLY identity source. */
  actorId?: string;
}

export class GetCustomerProfileUseCase {
  constructor(
    private readonly customerRepository: ICustomerRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: GetCustomerProfileInput): Promise<Customer> {
    const customerId = (input.customerId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    if (!customerId) {
      throw new DomainError("VALIDATION_ERROR", "customerId is required.");
    }

    let customer: Customer | null;
    try {
      customer = await this.customerRepository.findById(customerId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch customer profile", {
        err,
        customerId,
      });

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

    if (!customer) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Customer not found.");
    }

    // Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "CUSTOMER_PROFILE_RETRIEVED", {
        auditId: this.idGenerator.generate(),
        customerId,
        retrievedAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for customer profile retrieval", {
        err: auditErr,
        customerId,
      });
    }

    this.logger.info("Retrieved customer profile", { customerId, actorId });
    return customer;
  }
}