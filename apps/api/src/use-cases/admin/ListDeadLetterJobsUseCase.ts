// apps/api/src/use-cases/admin/ListDeadLetterJobsUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { DeadLetterJob } from "@api/domain/shared/workflow";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for listing dead-letter (failed) jobs from a queue.
 */
export interface ListDeadLetterJobsInput {
  adminUserId?: string; // optional, used for audit logging if provided
  queueName: string; // e.g., "webhook-queue", "logistics-queue"
  limit?: number; // page size
  offset?: number; // pagination offset
}

/**
 * Minimal shape for a dead-letter job returned by the queue service.
 * The concrete queue adapter may return additional fields; keep this
 * flexible while documenting the expected fields.
 */
/**
 * Use case: retrieve failed (dead-letter) jobs from a named queue.
 *
 * Responsibilities:
 * - Validate inputs and enforce sensible pagination bounds.
 * - Call the queue service to fetch failed jobs.
 * - Map queue/adapter errors to DomainError with stable codes.
 * - Emit a non-blocking audit log entry when adminUserId is provided.
 * - Log important events and failures via injected logger.
 */
export class ListDeadLetterJobsUseCase {
  // sensible defaults and limits
  private static readonly DEFAULT_LIMIT = 20;
  private static readonly MAX_LIMIT = 200;
  private static readonly MAX_OFFSET = 10_000_000;

  constructor(
    private queueService: IQueueService,
    private auditLogService: IAuditLogService,
    private logger: ILogger,
  ) {}

  /**
   * Execute the use case.
   * Returns an array of dead-letter jobs (shape depends on queue adapter).
   */
  async execute(input: ListDeadLetterJobsInput): Promise<DeadLetterJob[]> {
    // --- Normalize and validate inputs
    const queueName = (input.queueName ?? "").trim();
    const adminUserId = input.adminUserId?.trim();
    const limit = Number.isInteger(input.limit)
      ? input.limit!
      : ListDeadLetterJobsUseCase.DEFAULT_LIMIT;
    const offset = Number.isInteger(input.offset) ? input.offset! : 0;

    if (!queueName) {
      throw new DomainError("VALIDATION_ERROR", "queueName is required.");
    }

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "limit must be a positive integer.",
      );
    }
    if (limit > ListDeadLetterJobsUseCase.MAX_LIMIT) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `limit cannot exceed ${ListDeadLetterJobsUseCase.MAX_LIMIT}.`,
      );
    }

    if (!Number.isInteger(offset) || offset < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "offset must be a non-negative integer.",
      );
    }
    if (offset > ListDeadLetterJobsUseCase.MAX_OFFSET) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `offset cannot exceed ${ListDeadLetterJobsUseCase.MAX_OFFSET}.`,
      );
    }

    // --- Fetch failed jobs from the queue service
    let failedJobs: DeadLetterJob[] = [];
    try {
      // queueService.getFailedJobs should return an array of job objects
      failedJobs = await this.queueService.getFailedJobs(
        queueName,
        offset,
        limit,
      );
      // Defensive normalization: ensure an array is returned
      if (!Array.isArray(failedJobs)) {
        this.logger.warn(
          "Queue service returned non-array for failed jobs; normalizing to empty array",
          {
            queueName,
            offset,
            limit,
            returnedType: typeof failedJobs,
          },
        );
        failedJobs = [];
      }
    } catch (err: unknown) {
      // Map repository/queue adapter errors to DomainError with stable codes
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error(
          "Queue connection error while listing dead-letter jobs",
          { err, queueName, offset, limit },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue connection error while retrieving dead-letter jobs.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("Queue timeout while listing dead-letter jobs", {
          err,
          queueName,
          offset,
          limit,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue timeout while retrieving dead-letter jobs.",
        );
      }

      // Generic fallback: log and wrap unexpected errors
      this.logger.error("Failed to retrieve dead-letter jobs from queue", {
        err,
        queueName,
        offset,
        limit,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to retrieve dead-letter jobs.",
      );
    }

    // --- Audit log the read operation (non-blocking)
    if (adminUserId) {
      try {
        await this.auditLogService.logAction(adminUserId, "DLQ_LIST_READ", {
          queueName,
          offset,
          limit,
          returnedCount: failedJobs.length,
        });
      } catch (auditErr: unknown) {
        // Audit failures should not block the main operation; log and continue
        this.logger.warn("Audit log failed for dead-letter jobs listing", {
          err: auditErr,
          adminUserId,
          queueName,
        });
      }
    }

    // --- Final info log and return
    this.logger.info("Retrieved dead-letter jobs", {
      queueName,
      offset,
      limit,
      returnedCount: failedJobs.length,
    });

    return failedJobs;
  }
}
