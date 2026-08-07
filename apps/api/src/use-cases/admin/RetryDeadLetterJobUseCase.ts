// apps/api/src/use-cases/admin/RetryDeadLetterJobUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for retrying a dead-letter job.
 * - adminUserId is optional but recommended for auditability.
 */
export interface RetryDeadLetterJobInput {
  adminUserId?: string;
  queueName: string;
  jobId: string;
}

/**
 * Use case: retry a job from a dead-letter queue (DLQ).
 *
 * Responsibilities:
 * - Validate inputs and enforce sensible limits.
 * - Call the queue adapter to retry the job.
 * - Map queue/adapter errors to DomainError with stable codes/messages.
 * - Emit a non-blocking audit log entry recording the retry attempt.
 * - Log important events and failures via injected logger.
 */
export class RetryDeadLetterJobUseCase {
  // Optional limits to avoid accidental large requests
  private static readonly MAX_JOB_ID_LENGTH = 200;
  private static readonly MAX_QUEUE_NAME_LENGTH = 200;

  constructor(
    private queueService: IQueueService,
    private auditLogService: IAuditLogService,
    private logger: ILogger,
  ) {}

  async execute(input: RetryDeadLetterJobInput): Promise<void> {
    // --- Normalize and validate inputs
    const adminUserId = (input.adminUserId ?? "").trim();
    const queueName = (input.queueName ?? "").trim();
    const jobId = (input.jobId ?? "").trim();

    if (!queueName) {
      throw new DomainError("VALIDATION_ERROR", "queueName is required.");
    }
    if (!jobId) {
      throw new DomainError("VALIDATION_ERROR", "jobId is required.");
    }
    if (queueName.length > RetryDeadLetterJobUseCase.MAX_QUEUE_NAME_LENGTH) {
      throw new DomainError("VALIDATION_ERROR", "queueName is too long.");
    }
    if (jobId.length > RetryDeadLetterJobUseCase.MAX_JOB_ID_LENGTH) {
      throw new DomainError("VALIDATION_ERROR", "jobId is too long.");
    }

    // --- Attempt to retry the job via the queue adapter
    let retryResult: boolean;
    try {
      retryResult = await this.queueService.retryJob(queueName, jobId);
    } catch (err: any) {
      // Map adapter-level errors to DomainError with stable messages
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("Queue connection error while retrying DLQ job", {
          err,
          queueName,
          jobId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue connection error while retrying job.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("Queue timeout while retrying DLQ job", {
          err,
          queueName,
          jobId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue timeout while retrying job.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.NOT_FOUND) {
        // Adapter indicates the job or queue was not found
        this.logger.warn("Job or queue not found while retrying DLQ job", {
          err,
          queueName,
          jobId,
        });
        throw new DomainError(
          "RESOURCE_NOT_FOUND",
          "The specified job or queue was not found.",
        );
      }

      // Generic fallback for other adapter errors
      this.logger.error("Failed to retry DLQ job due to queue adapter error", {
        err,
        queueName,
        jobId,
      });
      throw new DomainError(
        "JOB_PROCESSING_ERROR",
        "Failed to retry the job due to a queue error.",
      );
    }

    // --- Interpret result and map to domain-level errors if necessary
    if (!retryResult) {
      // Adapter returned false meaning the job could not be retried (e.g., already removed)
      this.logger.warn("Queue adapter reported retry failure (no-op)", {
        queueName,
        jobId,
      });
      throw new DomainError(
        "JOB_PROCESSING_ERROR",
        "Failed to push the job back to the active queue. It may no longer exist or is not retryable.",
      );
    }

    // --- Audit log the successful retry (non-blocking)
    if (adminUserId) {
      try {
        await this.auditLogService.logAction(adminUserId, "DLQ_JOB_RETRIED", {
          queueName,
          jobId,
          retriedAt: new Date().toISOString(),
        });
      } catch (auditErr: any) {
        // Audit failures should not block the main flow; log and continue
        this.logger.warn("Audit log failed for DLQ job retry", {
          err: auditErr,
          queueName,
          jobId,
          adminUserId,
        });
      }
    }

    // --- Final info log
    this.logger.info("Dead-letter job retried successfully", {
      queueName,
      jobId,
      adminUserId: adminUserId || null,
    });
  }
}
