// apps/api/src/use-cases/customers/ProcessCustomerDataErasureUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { ISessionRevocationService } from "@api/domain/interfaces/services/ISessionRevocationService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { Customer } from "@api/domain/entities/Customer";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: process a customer's data erasure request (GDPR/CCPA style).
 *
 * Responsibilities:
 * - Validate input and caller context.
 * - Load the customer and short-circuit if not found.
 * - Ask the domain entity to anonymize/wipe PII fields.
 * - Persist the anonymized customer record (transactionally).
 * - Revoke active sessions and tokens for the customer (best-effort).
 * - Emit a non-blocking audit log entry recording the erasure.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Log structured events and failures for observability.
 */
export interface ProcessCustomerDataErasureInput {
  customerId: string;
  requestingAdminId?: string; // If executed via admin portal
  reason?: string;
  actorId?: string;
}

export class ProcessCustomerDataErasureUseCase {
  constructor(
    private readonly customerRepository: ICustomerRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly sessionRevocationService: ISessionRevocationService | null,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: ProcessCustomerDataErasureInput): Promise<void> {
    const customerId = (input.customerId ?? "").trim();
    const actorId =
      (input.actorId ?? input.requestingAdminId ?? "system").trim() || "system";
    const reason = (input.reason ?? "DATA_ERASURE_REQUEST").trim();

    // --- Validate input
    if (!customerId) {
      throw new DomainError("VALIDATION_ERROR", "customerId is required.");
    }

    // --- Load customer
    let customer: Customer | null;
    try {
      customer = await this.customerRepository.findById(customerId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch customer for data erasure", {
        err,
        customerId,
        actorId,
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
      this.logger.info("Customer not found for data erasure request", {
        customerId,
        actorId,
      });
      throw new DomainError("RESOURCE_NOT_FOUND", "Customer not found.");
    }

    // --- Perform anonymization using domain entity method
    try {
      customer.anonymizePII({
        reason,
        erasedBy: actorId,
        erasedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      this.logger.error("Domain-level anonymization failed", {
        err,
        customerId,
        actorId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to anonymize customer data.",
      );
    }

    // --- Persist anonymized customer (transactional)
    try {
      const persist = async () => {
        await this.customerRepository.save(customer);
      };

      await this.transactionManager.execute(persist);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist anonymized customer", {
        err,
        customerId,
        actorId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Concurrent modification detected while erasing customer data.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving anonymized customer.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving anonymized customer.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist customer anonymization.",
      );
    }

    // --- Revoke sessions and tokens (best-effort)
    try {
      if (this.sessionRevocationService) {
        await this.sessionRevocationService.revokeSessionsForUser(customerId);
      } else {
        this.logger.info(
          "No sessionRevocationService configured; skipping session revocation",
          { customerId },
        );
      }
    } catch (err: unknown) {
      this.logger.warn("Failed to revoke sessions after data erasure", {
        err,
        customerId,
      });
      // Do not fail the erasure if revocation fails; continue to audit
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "DATA_ERASURE_COMPLETED", {
        auditId: this.idGenerator.generate(),
        customerId,
        erasedAt: new Date().toISOString(),
        erasedBy: actorId,
        reason,
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for customer data erasure", {
        err: auditErr,
        customerId,
        actorId,
      });
    }

    this.logger.info("Customer data erasure completed", {
      customerId,
      actorId,
    });
    return;
  }
}
