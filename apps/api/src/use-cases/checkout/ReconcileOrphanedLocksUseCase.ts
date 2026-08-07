// apps/api/src/use-cases/checkout/ReconcileOrphanedLocksUseCase.ts

import { IDatabaseManagementService } from "@api/domain/interfaces/services/IDatabaseManagementService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { DatabaseTerminationResult } from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: reconcile orphaned database locks and terminate stale transactions.
 *
 * Responsibilities:
 * - Validate and normalize inputs (timeout threshold).
 * - Interact with the database management service to identify and terminate stale transactions.
 * - Map adapter/service errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the reconciliation attempt and outcome.
 * - Log structured events and failures for observability.
 */
export class ReconcileOrphanedLocksUseCase {
  private static readonly DEFAULT_STALE_MS = 30_000; // 30 seconds
  private static readonly MAX_STALE_MS = 3_600_000; // 1 hour

  constructor(
    private readonly dbManagementService: IDatabaseManagementService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  /**
   * Execute reconciliation of orphaned locks.
   *
   * @param staleThresholdMs - Milliseconds threshold for considering a transaction stale.
   *                           If omitted, defaults to 30_000 (30s).
   * @param actorId - Optional actor performing the operation for audit purposes.
   */
  async execute(staleThresholdMs?: number, actorId?: string): Promise<void> {
    const actor = (actorId ?? "").trim() || "system";
    const threshold = Number.isFinite(staleThresholdMs as number)
      ? Math.max(
          0,
          Math.min(
            ReconcileOrphanedLocksUseCase.MAX_STALE_MS,
            staleThresholdMs!,
          ),
        )
      : ReconcileOrphanedLocksUseCase.DEFAULT_STALE_MS;

    if (!Number.isInteger(threshold) || threshold <= 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "staleThresholdMs must be a positive integer.",
      );
    }

    this.logger.info("Starting reconciliation of orphaned locks", {
      actor,
      staleThresholdMs: threshold,
    });

    let terminatedCount = 0;
    try {
      // The DB management service returns the number of terminated transactions or details.
      const result =
        await this.dbManagementService.terminateStaleTransactions(threshold);

      // Normalize result to a count for logging/audit
      if (typeof result === "number") {
        terminatedCount = result;
      } else if (Array.isArray(result)) {
        terminatedCount = result.length;
      } else if (
        result &&
        typeof (result as DatabaseTerminationResult).terminatedCount ===
          "number"
      ) {
        terminatedCount = (result as DatabaseTerminationResult).terminatedCount;
      } else {
        // Unknown shape — log and treat as zero
        this.logger.warn(
          "Database management service returned unexpected shape for terminateStaleTransactions",
          {
            returnedType: typeof result,
            actor,
            staleThresholdMs: threshold,
          },
        );
        terminatedCount = 0;
      }
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to reconcile orphaned locks", {
        err,
        actor,
        staleThresholdMs: threshold,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while reconciling orphaned locks.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Timeout while reconciling orphaned locks.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.UNAUTHORIZED) {
        throw new DomainError(
          "PERMISSION_DENIED",
          "Insufficient privileges to terminate database transactions.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to reconcile orphaned locks.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actor, "ORPHANED_LOCKS_RECONCILED", {
        auditId: this.idGenerator.generate(),
        staleThresholdMs: String(threshold),
        terminatedCount: String(terminatedCount),
        reconciledAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for orphaned locks reconciliation", {
        err: auditErr,
        actor,
        staleThresholdMs: threshold,
      });
    }

    this.logger.info("Completed reconciliation of orphaned locks", {
      actor,
      staleThresholdMs: threshold,
      terminatedCount,
    });
    return;
  }
}
