// apps/api/src/use-cases/checkout/QueuePaymentEventUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  parsePaymentEventJobPayload,
  PaymentEventJobPayload,
  QUEUE_NAMES,
} from "@api/domain/shared/jobs";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface QueuePaymentEventInput {
  /**
   * The provider-agnostic internal payment event the worker consumes. This is
   * ALWAYS the typed `PaymentEventJobPayload` produced by the provider webhook
   * mapper (PaystackWebhookPayloadMapper at the application/infrastructure
   * boundary) — the raw provider envelope never crosses into the queue, and the
   * worker never parses it.
   */
  paymentEvent: PaymentEventJobPayload;
  actorId?: string;
}

/**
 * Use case: enqueue a payment event for asynchronous processing.
 *
 * Responsibilities:
 * - Accept the TYPED internal `PaymentEventJobPayload` (never a raw provider
 *   envelope) and validate it against the queue contract via
 *   `parsePaymentEventJobPayload`; malformed payloads are a permanent
 *   VALIDATION_ERROR and are never enqueued.
 * - Enforce enqueue idempotency by using the transactionReference as the jobId.
 * - Provide sensible job options (retries, backoff, removeOnComplete).
 *   Execution-time policies such as timeouts are worker concerns and are not
 *   expressed as producer options here.
 * - Map adapter/repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the enqueue attempt and outcome.
 * - Log structured events and failures for observability.
 */
export class QueuePaymentEventUseCase {
  private static readonly DEFAULT_QUEUE_NAME = QUEUE_NAMES.paymentEvents;
  private static readonly DEFAULT_ATTEMPTS = 5;
  private static readonly DEFAULT_BACKOFF_MS = 2000; // exponential backoff base

  constructor(
    private readonly queueService: IQueueService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: QueuePaymentEventInput): Promise<void> {
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Validate against the internal contract (single source of truth) ------
    // parsePaymentEventJobPayload throws VALIDATION_ERROR for a malformed
    // payload; this is the producer-side guarantee that the worker only ever
    // sees a well-formed internal event.
    const paymentEvent = parsePaymentEventJobPayload(input.paymentEvent);
    const transactionReference = paymentEvent.transactionReference;

    // --- Prepare job options (idempotent jobId = transactionReference)
    const jobId = transactionReference;
    const jobOptions = {
      jobId,
      attempts: QueuePaymentEventUseCase.DEFAULT_ATTEMPTS,
      backoff: {
        type: "exponential",
        delayMs: QueuePaymentEventUseCase.DEFAULT_BACKOFF_MS,
      },
      removeOnComplete: true,
      removeOnFail: false,
      priority: "high",
    };

    // --- Enqueue the typed internal payload (never a raw provider envelope)
    try {
      await this.queueService.enqueueJob(
        QueuePaymentEventUseCase.DEFAULT_QUEUE_NAME,
        paymentEvent,
        jobOptions,
      );

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(actorId, "PAYMENT_EVENT_QUEUED", {
          auditId: this.idGenerator.generate(),
          transactionReference: jobId,
          queue: QueuePaymentEventUseCase.DEFAULT_QUEUE_NAME,
          attempts: String(jobOptions.attempts),
          enqueuedAt: new Date().toISOString(),
        });
      } catch (auditErr: unknown) {
        this.logger.warn("Audit log failed for queued payment event", {
          err: auditErr,
          transactionReference: jobId,
        });
      }

      this.logger.info("Enqueued payment event", {
        transactionReference: jobId,
        queue: QueuePaymentEventUseCase.DEFAULT_QUEUE_NAME,
      });
      return;
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;

      // Map common adapter errors to domain-level errors
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error(
          "Queue service connection error while enqueuing payment event",
          { err, transactionReference: jobId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to enqueue payment event due to queue connection error.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error(
          "Queue service timeout while enqueuing payment event",
          { err, transactionReference: jobId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue service timed out while enqueuing payment event.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // If the queue adapter signals a duplicate job, treat as idempotent success
        this.logger.info(
          "Duplicate enqueue attempt detected for payment event; treating as idempotent success",
          { transactionReference: jobId },
        );
        try {
          await this.auditLogService.logAction(
            actorId,
            "PAYMENT_EVENT_ALREADY_QUEUED",
            {
              auditId: this.idGenerator.generate(),
              transactionReference: jobId,
              queue: QueuePaymentEventUseCase.DEFAULT_QUEUE_NAME,
              notedAt: new Date().toISOString(),
            },
          );
        } catch {
          /* swallow audit errors */
        }
        return;
      }

      // Generic fallback
      this.logger.error("Failed to enqueue payment event", {
        err,
        transactionReference: jobId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to enqueue payment event.",
      );
    }
  }
}
