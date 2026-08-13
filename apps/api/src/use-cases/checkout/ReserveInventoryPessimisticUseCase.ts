// apps/api/src/use-cases/checkout/ReserveInventoryPessimisticUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IVariantRepository } from "@api/domain/interfaces/repositories/IVariantRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ProductVariant } from "@api/domain/entities/ProductVariant";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: reserve inventory using pessimistic locking (SELECT ... FOR UPDATE NOWAIT).
 *
 * Responsibilities:
 * - Validate inputs and requested quantity.
 * - Open a transactional unit of work via ITransactionManager.
 * - Acquire a row-level lock on the variant within that transaction.
 * - Fail fast when lock cannot be acquired to avoid contention (LOCK_ACQUISITION_FAILED).
 * - Enforce inventory rules (no over-subscription unless allowed).
 * - Deduct inventory and persist within the same transactional boundary.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the reservation attempt and outcome.
 * - Log structured events and failures for observability.
 */
export interface ReserveInventoryPessimisticInput {
  variantId: string;
  requestedQuantity: number;
  actorId?: string;
}

export class ReserveInventoryPessimisticUseCase {
  private static readonly MIN_REQUEST_QTY = 1;
  private static readonly MAX_REQUEST_QTY = 10_000; // defensive upper bound

  constructor(
    private readonly variantRepository: IVariantRepository,
    private readonly transactionManager: ITransactionManager,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(request: ReserveInventoryPessimisticInput): Promise<void> {
    const variantId = (request.variantId ?? "").trim();
    const requestedQuantity = Number(request.requestedQuantity);
    const actorId = (request.actorId ?? "").trim() || "system";

    // --- Validate inputs
    if (!variantId) {
      throw new DomainError("VALIDATION_ERROR", "variantId is required.");
    }
    if (
      !Number.isInteger(requestedQuantity) ||
      requestedQuantity < ReserveInventoryPessimisticUseCase.MIN_REQUEST_QTY
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `requestedQuantity must be an integer >= ${ReserveInventoryPessimisticUseCase.MIN_REQUEST_QTY}.`,
      );
    }
    if (
      requestedQuantity > ReserveInventoryPessimisticUseCase.MAX_REQUEST_QTY
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `requestedQuantity exceeds maximum allowed (${ReserveInventoryPessimisticUseCase.MAX_REQUEST_QTY}).`,
      );
    }
    // --- Reserve inventory within a transactional unit of work
    try {
      const reservation = await this.transactionManager.execute(async () => {
        // Acquire a row-level lock within the current transaction
        let variant: ProductVariant | null;
        try {
          variant =
            await this.variantRepository.lockVariantForUpdateNoWait(variantId);
        } catch (err: unknown) {
          const repoErr = err as RepositoryError | undefined;
          this.logger.error("Failed to acquire lock for variant", {
            err,
            variantId,
            actorId,
          });

          // Map adapter-specific errors conservatively
          if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
            throw new DomainError(
              "INTERNAL_ERROR",
              "Database connection error while attempting to lock inventory.",
            );
          }
          if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
            throw new DomainError(
              "INTERNAL_ERROR",
              "Database timeout while attempting to lock inventory.",
            );
          }

          // If the adapter signals lock contention explicitly, map to LOCK_ACQUISITION_FAILED
          if (
            repoErr?.code === RepositoryErrorCode.LOCKED ||
            repoErr?.code === RepositoryErrorCode.NOWAIT
          ) {
            throw new DomainError(
              "LOCK_ACQUISITION_FAILED",
              "System busy. Another transaction is currently locking this inventory.",
            );
          }

          // Generic fallback
          throw new DomainError(
            "INTERNAL_ERROR",
            "Failed to acquire inventory lock.",
          );
        }

        if (!variant) {
          // Lock acquisition returned null (no row or lock not acquired)
          this.logger.info("Lock acquisition returned no variant", {
            variantId,
            actorId,
          });
          throw new DomainError(
            "LOCK_ACQUISITION_FAILED",
            "System busy. Another transaction is currently locking this inventory.",
          );
        }

        // --- Validate inventory and business rules
        const available = Number(variant.inventoryQuantity ?? 0);
        const allowBackorder = Boolean(variant.allowBackorder);

        if (!allowBackorder && available < requestedQuantity) {
          this.logger.info("Insufficient inventory for reservation", {
            variantId,
            available,
            requestedQuantity,
            actorId,
          });
          throw new DomainError(
            "OUT_OF_STOCK",
            "Insufficient physical inventory.",
          );
        }

        // Deduct inventory using the domain method
        variant.deductInventory(requestedQuantity);

        // Persist within the same transactional boundary
        await this.variantRepository.save(variant);

        this.logger.info("Inventory reserved (pessimistic)", {
          variantId,
          requestedQuantity,
          remainingQuantity: variant.inventoryQuantity,
          actorId,
        });

        return { variant, available };
      });

      // --- Audit log (post-commit, best-effort)
      try {
        await this.auditLogService.logAction(
          actorId,
          "INVENTORY_RESERVED",
          {
            auditId: this.idGenerator.generate(),
            variantId,
            requestedQuantity: String(requestedQuantity),
            remainingQuantity: String(
              reservation.variant.inventoryQuantity ??
                reservation.available - requestedQuantity,
            ),
            reservedAt: new Date().toISOString(),
          },
        );
      } catch (auditErr: unknown) {
        this.logger.warn("Audit log failed for inventory reservation", {
          err: auditErr,
          variantId,
          actorId,
        });
      }
    } catch (err: unknown) {
      // If we threw a DomainError above (e.g., OUT_OF_STOCK, LOCK_ACQUISITION_FAILED), rethrow it
      if (err instanceof DomainError) {
        throw err;
      }

      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed while reserving inventory", {
        err,
        variantId,
        requestedQuantity,
        actorId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while reserving inventory.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while reserving inventory.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // Unlikely for inventory save, but handle defensively
        throw new DomainError(
          "INVALID_OPERATION",
          "Concurrent modification detected while reserving inventory.",
        );
      }

      // Generic fallback
      throw new DomainError("INTERNAL_ERROR", "Failed to reserve inventory.");
    }
  }
}
