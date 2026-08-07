// apps/api/src/use-cases/cart/PruneAbandonedCartsUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface PruneAbandonedCartsInput {
  expirationDateThreshold: Date; // e.g., 7 days ago
}

/**
 * Use case: delete carts that have been abandoned past a threshold and not converted to orders.
 *
 * Responsibilities:
 * - Validate the expiration threshold input.
 * - Remove carts not updated since the threshold and not transitioned into an Order.
 * - Perform deletion atomically via the transaction manager.
 * - Return the number of deleted carts for reporting/monitoring.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the prune operation and outcome.
 */
export class PruneAbandonedCartsUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(
    input: PruneAbandonedCartsInput,
  ): Promise<{ deletedCount: number }> {
    // --- Validate input
    if (
      !input ||
      !(input.expirationDateThreshold instanceof Date) ||
      Number.isNaN(input.expirationDateThreshold.getTime())
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "expirationDateThreshold must be a valid Date.",
      );
    }

    const threshold = input.expirationDateThreshold;
    const now = new Date();
    if (threshold > now) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "expirationDateThreshold cannot be in the future.",
      );
    }

    // --- Perform deletion atomically via the transaction manager
    try {
      const performPrune = async () => {
        // Repository is expected to return the number of deleted carts
        const deletedCount =
          await this.cartRepository.deleteAbandonedCarts(threshold);
        return deletedCount;
      };

      const deletedCount =
        await this.transactionManager.execute(performPrune);

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction("system", "CARTS_PRUNED", {
          jobId: this.idGenerator.generate(),
          threshold: threshold.toISOString(),
          deletedCount: String(deletedCount),
        });
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for prune abandoned carts", {
          err: auditErr,
          threshold: threshold.toISOString(),
        });
      }

      this.logger.info("Pruned abandoned carts", {
        threshold: threshold.toISOString(),
        deletedCount,
      });
      return { deletedCount };
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while pruning abandoned carts", {
          err,
          threshold: threshold.toISOString(),
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while pruning abandoned carts.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while pruning abandoned carts", {
          err,
          threshold: threshold.toISOString(),
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while pruning abandoned carts.",
        );
      }

      // Generic fallback
      this.logger.error("Failed to prune abandoned carts", {
        err,
        threshold: threshold.toISOString(),
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to prune abandoned carts.",
      );
    }
  }
}
