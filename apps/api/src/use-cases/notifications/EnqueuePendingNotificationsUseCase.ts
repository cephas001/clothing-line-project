// apps/api/src/use-cases/notifications/EnqueuePendingNotificationsUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { INotificationOutboxRepository } from "@api-domain-interfaces/repositories/INotificationOutboxRepository";
import { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import { QueueJobState } from "@api/domain/interfaces/services/IQueueService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  buildNotificationJobId,
  parseNotificationEventJobPayload,
  QUEUE_NAMES,
  NotificationEventJobPayload,
} from "@api/domain/shared/jobs";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface EnqueuePendingNotificationsInput {
  /** Max outbox rows relayed per sweep (default 100). */
  limit?: number;
}

export interface EnqueuePendingNotificationsResult {
  /** Rows relayed to the queue and marked queued. */
  enqueued: number;
  /** Rows whose enqueue failed transiently; LEFT pending for the next sweep. */
  failed: number;
  /** Corrupt rows marked failed (terminal) so the sweep never spins on them. */
  poisoned: number;
}

/**
 * Use case: relay pending notification outbox rows to the notification queue.
 *
 * This is the AFTER-COMMIT half of the L8 notification pipeline. Producing use
 * cases append a `NotificationIntent` inside their own business transaction;
 * this sweep (invoked on a schedule) finds the oldest pending rows and:
 *
 * 1. Re-validates the row's intent against the queue contract
 *    (`parseNotificationEventJobPayload`); a corrupt row is a PERMANENT
 *    failure — it is marked failed so the sweep never spins on it.
 * 2. Enqueues a `NotificationEventJobPayload` to `notification-events-queue`
 *    with a DETERMINISTIC jobId (`buildNotificationJobId(intent,
 *    discriminator)`), so duplicate deliveries and retries collapse onto the
 *    same BullMQ job while it exists.
 * 3. Marks the row `queued` ONLY after the enqueue was accepted — a row is
 *    never marked queued without a live job, and a transient queue failure
 *    leaves it `pending` for the next sweep (the commit -> enqueue crash
 *    window is therefore closed without double-sending).
 *
 * A transient enqueue failure (connection/timeout) does not abort the sweep:
 * the row is left pending, audited, and reported in `failed`.
 *
 * DUPLICATE CONFLICT RESOLUTION (L8-R PART 14 — closes the T3 finding): the
 * deterministic jobId is the queue's idempotency key, so a DUPLICATE enqueue
 * means a job with the same logical notification identity ALREADY exists. The
 * sweep only treats the row as already-queued when the queue can PROVE that
 * existing job is LIVE (`waiting` | `delayed` | `active` — it will actually be
 * delivered): it then marks the row queued with the same jobId and counts it
 * as enqueued. If the existing job cannot be proven valid (not found, failed,
 * completed, paused, or the proof query itself errors), the sweep FAILS CLOSED:
 * the row stays pending and the conflict is reported in `failed` — never is a
 * row marked queued against a job we cannot prove will deliver.
 */
export class EnqueuePendingNotificationsUseCase {
  private static readonly DEFAULT_QUEUE_NAME = QUEUE_NAMES.notificationEvents;
  private static readonly DEFAULT_BATCH_SIZE = 100;
  private static readonly DEFAULT_ATTEMPTS = 5;
  private static readonly DEFAULT_BACKOFF_MS = 2000; // exponential backoff base

  /**
   * Queue job states that PROVE a job will actually be delivered. Anything
   * else (completed/failed/paused/waiting-children/unknown) is not proof, and
   * the sweep must fail closed rather than mark a row queued against it.
   */
  private static readonly LIVE_QUEUE_JOB_STATES: readonly QueueJobState[] = [
    "waiting",
    "delayed",
    "active",
  ];

  constructor(
    private readonly outboxRepository: INotificationOutboxRepository,
    private readonly queueService: IQueueService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(
    input?: EnqueuePendingNotificationsInput,
  ): Promise<EnqueuePendingNotificationsResult> {
    const limit = input?.limit ?? EnqueuePendingNotificationsUseCase.DEFAULT_BATCH_SIZE;
    const actorId = "system";
    let enqueued = 0;
    let failed = 0;
    let poisoned = 0;

    const pending = await this.outboxRepository.findPending(limit);

    for (const row of pending) {
      const enqueuedAt = new Date().toISOString();

      // --- Defense-in-depth: re-validate the durable intent before relaying ---
      // A corrupt row is a permanent failure: mark it failed (terminal) so the
      // sweep never spins on it, then continue.
      const payload: NotificationEventJobPayload = {
        outboxRecordId: row.id,
        intent: row.payload,
        enqueuedAt,
      };
      try {
        parseNotificationEventJobPayload(payload);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Malformed notification intent.";
        await this.outboxRepository.markFailed(row.id, message, row.attempts);
        poisoned += 1;
        try {
          await this.auditLogService.logAction(actorId, "NOTIFICATION_POISONED", {
            auditId: this.idGenerator.generate(),
            outboxRecordId: row.id,
            intentType: row.intentType,
            reason: message,
            markedAt: new Date().toISOString(),
          });
        } catch {
          /* audit is best-effort */
        }
        this.logger.error("Poisoned notification outbox row marked failed", {
          outboxRecordId: row.id,
          err: err as Error,
        });
        continue;
      }

      // --- Enqueue with a deterministic idempotency key ---------------------
      const jobId = buildNotificationJobId(row.payload, row.discriminator);
      const jobOptions = {
        jobId,
        attempts: EnqueuePendingNotificationsUseCase.DEFAULT_ATTEMPTS,
        backoff: {
          type: "exponential",
          delayMs: EnqueuePendingNotificationsUseCase.DEFAULT_BACKOFF_MS,
        },
        removeOnComplete: true,
        removeOnFail: false,
      };

      try {
        await this.queueService.enqueueJob(
          EnqueuePendingNotificationsUseCase.DEFAULT_QUEUE_NAME,
          payload,
          jobOptions,
        );
        // --- Mark queued ONLY after the job was accepted --------------------
        await this.outboxRepository.markQueued(row.id, jobId);

        try {
          await this.auditLogService.logAction(actorId, "NOTIFICATION_ENQUEUED", {
            auditId: this.idGenerator.generate(),
            outboxRecordId: row.id,
            intentType: row.intentType,
            aggregateId: row.aggregateId,
            discriminator: row.discriminator ?? undefined,
            jobId,
            queue: EnqueuePendingNotificationsUseCase.DEFAULT_QUEUE_NAME,
            enqueuedAt,
          });
        } catch {
          /* audit is best-effort */
        }

        enqueued += 1;
        this.logger.info("Enqueued notification outbox row", {
          outboxRecordId: row.id,
          intentType: row.intentType,
          jobId,
        });
      } catch (err: unknown) {
        const repoErr = err as RepositoryError | undefined;
        const code = repoErr?.code ?? RepositoryErrorCode.UNKNOWN;

        // --- DUPLICATE jobId conflict (T3 -> L8-R PART 14) ------------------
        // The deterministic jobId refused a duplicate: a job with the same
        // logical identity already exists. Treat the row as already-queued ONLY
        // when the queue proves that existing job is LIVE (waiting/delayed/
        // active — it will actually be delivered). Otherwise FAIL CLOSED: the
        // row stays pending and the conflict is reported transient, never
        // marking queued against a job we cannot prove is valid.
        if (code === RepositoryErrorCode.DUPLICATE) {
          let existingLive = false;
          try {
            const state = await this.queueService.getJobState(
              EnqueuePendingNotificationsUseCase.DEFAULT_QUEUE_NAME,
              jobId,
            );
            existingLive =
              state !== null &&
              (
                EnqueuePendingNotificationsUseCase.LIVE_QUEUE_JOB_STATES as readonly QueueJobState[]
              ).includes(state);
          } catch {
            // Cannot prove the existing job is valid — fail closed.
            existingLive = false;
          }

          if (existingLive) {
            await this.outboxRepository.markQueued(row.id, jobId);
            try {
              await this.auditLogService.logAction(
                actorId,
                "NOTIFICATION_ALREADY_QUEUED",
                {
                  auditId: this.idGenerator.generate(),
                  outboxRecordId: row.id,
                  intentType: row.intentType,
                  aggregateId: row.aggregateId,
                  discriminator: row.discriminator ?? undefined,
                  jobId,
                  queue: EnqueuePendingNotificationsUseCase.DEFAULT_QUEUE_NAME,
                  resolvedAt: new Date().toISOString(),
                },
              );
            } catch {
              /* audit is best-effort */
            }
            enqueued += 1;
            this.logger.info(
              "Notification outbox row is already queued (DUPLICATE jobId resolved against a live job)",
              { outboxRecordId: row.id, intentType: row.intentType, jobId },
            );
            continue;
          }
          // Unprovable conflict: fall through to transient handling (pending).
        }

        // Transient queue failure: leave the row pending for the next sweep.
        // The deterministic jobId means a later successful enqueue cannot
        // double-send while the job exists.
        failed += 1;
        try {
          await this.auditLogService.logAction(actorId, "NOTIFICATION_ENQUEUE_FAILED", {
            auditId: this.idGenerator.generate(),
            outboxRecordId: row.id,
            intentType: row.intentType,
            jobId,
            errorCode: code,
            errorMessage: err instanceof Error ? err.message : "Unknown enqueue failure.",
            notedAt: new Date().toISOString(),
          });
        } catch {
          /* audit is best-effort */
        }
        this.logger.error("Failed to enqueue notification outbox row (left pending)", {
          outboxRecordId: row.id,
          jobId,
          err: err as Error,
        });
      }
    }

    return { enqueued, failed, poisoned };
  }
}