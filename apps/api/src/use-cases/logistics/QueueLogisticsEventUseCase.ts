// apps/api/src/use-cases/logistics/QueueLogisticsEventUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  parseLogisticsEventJobPayload,
  LogisticsEventJobPayload,
  QUEUE_NAMES,
} from "@api/domain/shared/jobs";
import { ProviderLogisticsEvent } from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface QueueLogisticsEventInput {
  /**
   * The provider-neutral logistics event produced by the provider webhook
   * mapper (ShipbubbleWebhookPayloadMapper at the application/infrastructure
   * boundary). The raw provider envelope never crosses into the queue, and the
   * worker never parses it.
   */
  logisticsEvent: ProviderLogisticsEvent;
  actorId?: string;
}

/**
 * Use case: enqueue a logistics (courier tracking) event for asynchronous
 * processing.
 *
 * Responsibilities:
 * - Accept the TYPED provider-neutral `ProviderLogisticsEvent` (never a raw
 *   provider envelope) and project it onto the `LogisticsEventJobPayload` queue
 *   contract; the projection is re-validated via `parseLogisticsEventJobPayload`
 *   so a malformed event is a permanent VALIDATION_ERROR and is never enqueued.
 * - Enforce enqueue idempotency by using the deterministic `eventKey` as the
 *   jobId: ONE logical provider event -> exactly ONE job (duplicate deliveries
 *   and retries collapse onto the same job). The eventKey is derived by the
 *   mapper from stable provider fields only — never a timestamp or random UUID,
 *   and never the providerShipmentId alone.
 * - Provide sensible job options (retries, backoff, removeOnComplete).
 * - Map adapter/repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the enqueue attempt/outcome.
 * - Log structured events and failures for observability. The payload carries
 *   no API keys, auth headers, raw webhook bodies, or secrets.
 */
export class QueueLogisticsEventUseCase {
  private static readonly DEFAULT_QUEUE_NAME = QUEUE_NAMES.logisticsEvents;
  private static readonly DEFAULT_ATTEMPTS = 5;
  private static readonly DEFAULT_BACKOFF_MS = 2000; // exponential backoff base

  constructor(
    private readonly queueService: IQueueService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: QueueLogisticsEventInput): Promise<void> {
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Project + validate against the internal contract ---------------------
    // parseLogisticsEventJobPayload throws VALIDATION_ERROR for a malformed
    // payload; this is the producer-side guarantee that the worker only ever
    // sees a well-formed internal event.
    const { logisticsEvent } = input;
    const payload: LogisticsEventJobPayload = {
      provider: logisticsEvent.provider,
      eventKey: logisticsEvent.eventKey,
      eventType: logisticsEvent.eventType,
      providerShipmentId: logisticsEvent.providerShipmentId,
      trackingNumber: logisticsEvent.trackingNumber ?? null,
      courier: logisticsEvent.courier ?? null,
      status: logisticsEvent.status ?? null,
      occurredAt: logisticsEvent.occurredAt ?? null,
      // Only the explicit false is carried into the queue contract; an absent
      // notifyCustomer (the Shipbubble default) stays an OMITTED key so the
      // queue payload is byte-identical to the pre-courier contract.
      ...(logisticsEvent.notifyCustomer === false
        ? { notifyCustomer: false }
        : {}),
    };
    const validated = parseLogisticsEventJobPayload(payload);
    const eventKey = validated.eventKey;

    // --- Prepare job options (idempotent jobId = deterministic eventKey)
    const jobOptions = {
      jobId: eventKey,
      attempts: QueueLogisticsEventUseCase.DEFAULT_ATTEMPTS,
      backoff: {
        type: "exponential",
        delayMs: QueueLogisticsEventUseCase.DEFAULT_BACKOFF_MS,
      },
      removeOnComplete: true,
      removeOnFail: false,
      priority: "high",
    };

    // --- Enqueue the typed internal payload (never a raw provider envelope)
    try {
      await this.queueService.enqueueJob(
        QueueLogisticsEventUseCase.DEFAULT_QUEUE_NAME,
        validated,
        jobOptions,
      );

      try {
        await this.auditLogService.logAction(
          actorId,
          "LOGISTICS_EVENT_QUEUED",
          {
            auditId: this.idGenerator.generate(),
            eventKey,
            providerShipmentId: validated.providerShipmentId,
            eventType: validated.eventType,
            queue: QueueLogisticsEventUseCase.DEFAULT_QUEUE_NAME,
            attempts: String(jobOptions.attempts),
            enqueuedAt: new Date().toISOString(),
          },
        );
      } catch (auditErr: unknown) {
        this.logger.warn("Audit log failed for queued logistics event", {
          err: auditErr,
          eventKey,
        });
      }

      this.logger.info("Enqueued logistics event", {
        eventKey,
        providerShipmentId: validated.providerShipmentId,
        eventType: validated.eventType,
        queue: QueueLogisticsEventUseCase.DEFAULT_QUEUE_NAME,
      });
      return;
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error(
          "Queue service connection error while enqueuing logistics event",
          { err, eventKey },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to enqueue logistics event due to queue connection error.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error(
          "Queue service timeout while enqueuing logistics event",
          { err, eventKey },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue service timed out while enqueuing logistics event.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        this.logger.info(
          "Duplicate enqueue attempt detected for logistics event; treating as idempotent success",
          { eventKey },
        );
        try {
          await this.auditLogService.logAction(
            actorId,
            "LOGISTICS_EVENT_ALREADY_QUEUED",
            {
              auditId: this.idGenerator.generate(),
              eventKey,
              queue: QueueLogisticsEventUseCase.DEFAULT_QUEUE_NAME,
              notedAt: new Date().toISOString(),
            },
          );
        } catch {
          /* swallow audit errors */
        }
        return;
      }

      this.logger.error("Failed to enqueue logistics event", {
        err,
        eventKey,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to enqueue logistics event.",
      );
    }
  }
}