// apps/worker/src/workers/NotificationEventWorker.ts

// Concrete worker for the `notification-events-queue` published by
// EnqueuePendingNotificationsUseCase (L8-R PART 2/6 — the TIER 1 consumer that
// completes the durable notification pipeline).
//
// Each job carries the typed `NotificationEventJobPayload` contract
// ({ outboxRecordId, intent, enqueuedAt }) — never a provider raw identity.
// The worker:
// - re-validates the payload with `parseNotificationEventJobPayload` as
//   defense-in-depth (a malformed payload is a PERMANENT failure: QueueWorker
//   classifies VALIDATION_ERROR as non-retryable);
// - resolves the authoritative outbox row BY ITS DURABLE IDENTITY
//   (`findById`) and dispatches ONLY from that committed row — the frozen
//   provider-neutral intent, never the raw job data, is the source of truth
//   for what gets sent;
// - treats a job whose outbox row no longer exists as a permanent failure
//   (a job can never create its own row; retrying cannot fix an orphan);
// - NEVER re-dispatches a terminal row: an already-`dispatched` or `failed`
//   outbox row is a no-op (idempotent at-least-once delivery; a poisoned row
//   is never resurrected). A row still `pending` (the relay crashed between
//   enqueue and markQueued) is a legal deliverable — it holds the same
//   committed intent;
// - calls INotificationService OUTSIDE any database transaction (invariant:
//   no provider call inside a transaction) and only after the row resolves;
// - on success opens a SHORT local database transaction via the injected
//   ITransactionManager and persists the dispatch receipt on the row
//   (`markDispatched`: dispatched state + provider message id + job id);
// - on a TERMINAL provider rejection (auth/rejected/malformed/config — a
//   retry can never fix it) marks the row `failed` (terminal) and throws a
//   PermanentJobFailure ("UnrecoverableError") so BullMQ moves the job
//   straight to failed instead of looping; transient provider failures are
//   rethrown untouched so BullMQ applies the producer's retry/backoff.
//
// The worker never opens a transaction around anything external, never creates
// or mutates business aggregates, and never imports a concrete infrastructure
// class.

import type { ConnectionOptions, WorkerOptions } from "bullmq";
import { QueueWorker, PermanentJobFailure, WorkerJob } from "./QueueWorker";
import type { NotificationEventJobPayload } from "@api/domain/shared/jobs";
import { QUEUE_NAMES, parseNotificationEventJobPayload } from "@api/domain/shared/jobs";
import type { INotificationOutboxRepository } from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import type {
  INotificationService,
  NotificationDispatchResult,
  NotificationIntent,
} from "@api/domain/shared/notifications";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";

export interface NotificationEventWorkerOptions {
  /** BullMQ Redis connection config, derived from the shared REDIS_URL. */
  connection: ConnectionOptions;
  /** The durable notification outbox the worker reconciles. */
  outboxRepository: INotificationOutboxRepository;
  /**
   * Provider-neutral notification service. Invoked ONLY outside any DB
   * transaction and ONLY after the outbox row resolves.
   */
  notificationService: INotificationService;
  /** Opens the SHORT transaction that persists the dispatch receipt. */
  transactionManager: ITransactionManager;
  logger: ILogger;
  /** Must match QUEUE_NAMES.notificationEvents used by EnqueuePendingNotificationsUseCase. */
  queueName?: string;
  workerOptions?: Partial<WorkerOptions>;
}

/**
 * Dependencies the notification-job handler resolves per job (the same set the
 * worker was constructed with). Extracted so the E2E suite can drive the REAL
 * worker orchestration against in-memory fakes without BullMQ/Redis.
 */
export interface NotificationEventProcessingDependencies {
  /** The durable notification outbox the worker reconciles. */
  outboxRepository: INotificationOutboxRepository;
  /** Provider-neutral notification service (invoked OUTSIDE any transaction). */
  notificationService: INotificationService;
  /** Opens the SHORT transaction that persists the dispatch receipt. */
  transactionManager: ITransactionManager;
  logger: ILogger;
}

/**
 * Provider failure categories a retry can never fix. Structural check on the
 * thrown error (an adapter's discriminating `category`); the worker imports no
 * concrete adapter, so this stays adapter-agnostic.
 */
const TERMINAL_PROVIDER_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  "CONFIGURATION",
  "GATEWAY_AUTH",
  "GATEWAY_REJECTED",
  "MALFORMED_RESPONSE",
  "INVALID_PAYLOAD",
]);

export class NotificationEventWorker {
  public static readonly DEFAULT_QUEUE_NAME = QUEUE_NAMES.notificationEvents;

  private readonly worker: QueueWorker<NotificationEventJobPayload>;

  constructor(options: NotificationEventWorkerOptions) {
    const deps: NotificationEventProcessingDependencies = {
      outboxRepository: options.outboxRepository,
      notificationService: options.notificationService,
      transactionManager: options.transactionManager,
      logger: options.logger,
    };
    this.worker = new QueueWorker<NotificationEventJobPayload>({
      queueName: options.queueName ?? NotificationEventWorker.DEFAULT_QUEUE_NAME,
      connection: options.connection,
      logger: options.logger,
      workerOptions: options.workerOptions,
      handler: (job) => processNotificationEventJob(deps, job),
    });
  }

  start(): Promise<void> {
    return this.worker.start();
  }

  close(): Promise<void> {
    return this.worker.close();
  }
}

/**
 * Process ONE notification job end-to-end (the worker's full orchestration,
 * exposed for the E2E suite to exercise against in-memory fakes).
 *
 * Pipeline: re-validate payload -> resolve authoritative outbox row -> skip
 * terminal rows -> provider call (OUTSIDE any transaction) -> short transaction
 * persisting the dispatch receipt.
 */
export async function processNotificationEventJob(
  options: NotificationEventProcessingDependencies,
  job: WorkerJob<NotificationEventJobPayload>,
): Promise<void> {
  // --- Defense-in-depth: reject a malformed payload permanently -------
  const payload = parseNotificationEventJobPayload(job.data);

  // --- Resolve the AUTHORITATIVE outbox row (never the raw job data) --
  const row = await options.outboxRepository.findById(payload.outboxRecordId);
  if (!row) {
    throw new PermanentJobFailure(
      "RESOURCE_NOT_FOUND",
      `Notification outbox record '${payload.outboxRecordId}' referenced by job ${job.id} does not exist.`,
    );
  }

  // --- Terminal rows are never re-dispatched (idempotent delivery) -----
  // CRASH/IDEMPOTENCY SEMANTICS (L8-R PART 3): a `dispatched` row is the
  // durable record that a provider accepted delivery. Duplicate jobs
  // (BullMQ redelivery, a sweep re-enqueue) that resolve to a dispatched
  // row are acknowledged WITHOUT resending — dispatched rows are NEVER
  // intentionally resent. A `failed` row is terminal poison, equally
  // never resurrected. The only remaining double-send sub-window is the
  // provider-accepted-but-crash-before-markDispatched case: the row is
  // still `queued`, BullMQ re-delivers at-least-once, and the worker
  // sends again because the receipt was never recorded. That window is
  // closed the moment `markDispatched` lands (the guarded UPDATE makes a
  // concurrent duplicate a no-op); no blind retry is added around the
  // provider call.
  if (row.status === "dispatched" || row.status === "failed") {
    options.logger.info(
      "Notification outbox row is already terminal; acknowledging job without resending",
      { outboxRecordId: row.id, intentType: row.intentType, status: row.status, jobId: job.id },
    );
    return;
  }

  // --- Provider call: OUTSIDE any DB transaction, from committed state --
  // The row's payload is the frozen authoritative intent. A row still
  // `pending` (relay crash between enqueue and markQueued) is delivered
  // from the same committed intent and dispatched via the crash-recovery
  // transition `pending -> dispatched`.
  let result: NotificationDispatchResult;
  try {
    result = await dispatchNotification(options.notificationService, row.payload);
  } catch (err: unknown) {
    if (isTerminalProviderFailure(err)) {
      const reason = err instanceof Error ? err.message : "Notification provider rejected the dispatch permanently.";
      await options.outboxRepository.markFailed(row.id, reason, row.attempts);
      options.logger.error("Notification provider rejected dispatch permanently; outbox row marked failed", {
        outboxRecordId: row.id,
        intentType: row.intentType,
        err,
      });
      throw new PermanentJobFailure("NOTIFICATION_DISPATCH_REJECTED", reason);
    }
    throw err;
  }

  // --- Short local transaction: persist the delivery receipt -----------
  await options.transactionManager.execute(async () => {
    await options.outboxRepository.markDispatched(row.id, {
      providerMessageId: result.providerMessageId,
      jobId: job.id,
    });
  });
}

/** Route a frozen intent to the matching provider-neutral send method. */
async function dispatchNotification(
  service: INotificationService,
  intent: NotificationIntent,
): Promise<NotificationDispatchResult> {
  switch (intent.type) {
    case "payment_confirmation":
      return service.sendPaymentConfirmation(intent.payload);
    case "shipment_dispatched":
      return service.sendShipmentDispatched(intent.payload);
    case "tracking_update":
      return service.sendTrackingUpdate(intent.payload);
    case "refund_issued":
      return service.sendRefundIssued(intent.payload);
    case "password_reset":
      return service.sendPasswordReset(intent.payload);
    case "quote_approved":
      return service.sendQuoteApproved(intent.payload);
    case "draft_order_invoice":
      return service.sendDraftOrderInvoice(intent.payload);
  }
}

/** True for an adapter failure category that a retry can never fix. */
function isTerminalProviderFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("category" in err)) {
    return false;
  }
  const category = (err as { category?: unknown }).category;
  return (
    typeof category === "string" &&
    TERMINAL_PROVIDER_FAILURE_CATEGORIES.has(category)
  );
}