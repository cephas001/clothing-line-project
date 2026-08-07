// apps/api/src/use-cases/checkout/ProcessDeadLetterQueueUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: process a job that has landed in the dead-letter queue (DLQ).
 *
 * Responsibilities:
 * - Validate inputs (jobId, payload, errorReason).
 * - Move the job payload to durable DLQ storage for manual inspection.
 * - Emit a non-blocking audit log entry recording the DLQ entry and reason.
 * - Map adapter/repository errors to DomainError with clear domain codes.
 * - Log structured events and failures for observability.
 */
export interface ProcessDeadLetterQueueInput {
  jobId: string;
  payload: unknown;
  errorReason: string;
  actorId?: string;
  queueName?: string;
}

export class ProcessDeadLetterQueueUseCase {
  private static readonly DEFAULT_QUEUE = "payment-events-queue";

  constructor(
    private readonly queueService: IQueueService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: ProcessDeadLetterQueueInput): Promise<void> {
    const jobId = (input.jobId ?? "").trim();
    const payload = input.payload ?? null;
    const errorReason = (input.errorReason ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";
    const queueName =
      (input.queueName ?? "").trim() ||
      ProcessDeadLetterQueueUseCase.DEFAULT_QUEUE;

    // --- Validate inputs
    if (!jobId) {
      throw new DomainError("VALIDATION_ERROR", "jobId is required.");
    }
    if (payload === null || typeof payload === "undefined") {
      throw new DomainError("VALIDATION_ERROR", "payload is required.");
    }
    if (!errorReason) {
      throw new DomainError("VALIDATION_ERROR", "errorReason is required.");
    }

    // --- Move to DLQ storage
    try {
      await this.queueService.moveToDeadLetterQueue(queueName, jobId, payload);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to move job to dead-letter queue", {
        err,
        queueName,
        jobId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to persist DLQ entry due to queue connection error.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue adapter timed out while moving job to DLQ.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.PERMISSION) {
        throw new DomainError(
          "PERMISSION_DENIED",
          "Insufficient permissions to write to the dead-letter queue storage.",
        );
      }

      // Generic fallback
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to move job to dead-letter queue.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "DLQ_ENTRY_CREATED", {
        auditId: this.idGenerator.generate(),
        queue: queueName,
        jobId,
        errorReason,
        payloadPreview: this._safePreview(payload),
        createdAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for DLQ entry creation", {
        err: auditErr,
        queueName,
        jobId,
      });
    }

    this.logger.info("Job moved to dead-letter queue", {
      queueName,
      jobId,
      errorReason,
    });
    return;
  }

  /**
   * Create a compact, safe preview of the payload for logging/audit without leaking large data.
   */
  private _safePreview(payload: unknown): string {
    try {
      if (typeof payload === "string") {
        return payload.length > 512 ? `${payload.slice(0, 512)}...` : payload;
      }
      const json = JSON.stringify(payload);
      return json.length > 512 ? `${json.slice(0, 512)}...` : json;
    } catch {
      return "[unserializable payload]";
    }
  }
}
