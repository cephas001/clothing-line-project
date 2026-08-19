// apps/api/src/domain/interfaces/repositories/INotificationOutboxRepository.ts

// Durable notification outbox contract (L8 PART 2/3).
//
// Use cases that emit a notification append ONE row inside their own business
// transaction via `append` (so the row commits atomically with the state that
// produced the notification — no notification before commit, no provider call
// inside the transaction). `EnqueuePendingNotificationsUseCase` then relays
// pending rows to the notification queue and drives their status forward.
//
// The row is immutable once appended: `payload` is the full provider-neutral
// `NotificationIntent` and `discriminator` the per-occurrence identity for
// intents that fire more than once per aggregate (e.g. a courier
// `tracking_update`). Deterministic identity is (intentType, aggregateId,
// discriminator), enforced by a unique index in the migration so duplicate
// appends collide instead of double-sending.
//
// STATUS STATE MACHINE (L8-R PART 5) — enforced by the repository guards:
//
//   pending  --markQueued-->  queued  --markDispatched-->  dispatched (terminal)
//   pending  --markFailed---> failed  (terminal)
//   queued   --markFailed---> failed  (terminal)
//
// Guards (a transition that is NOT listed above is a no-op):
//   - `markQueued`     matches ONLY `pending` rows (a concurrent sweep that
//     already relayed the row is a no-op).
//   - `markDispatched` matches ONLY `pending` | `queued` rows. `pending` is
//     legal because the relay can crash between enqueue and markQueued — the
//     worker then delivers from the committed row and marks it dispatched
//     (at-least-once recovery). `dispatched` and `failed` rows are NEVER
//     re-dispatched, and a poisoned `failed` row is NEVER resurrected.
//   - `markFailed`     matches ONLY `pending` | `queued` rows; an already-failed
//     row keeps its original failure, and a delivered row is never failed.
//
// `findPending` only ever returns `pending` rows, so the relay sweep can never
// spin on `failed` (poisoned) rows — recovering them requires an explicit
// reconciliation outside the sweep.

import type { NotificationIntent } from "@api/domain/shared/notifications";

export type NotificationOutboxStatus =
  | "pending"
  | "queued"
  | "dispatched"
  | "failed";

export interface NotificationOutboxRecord {
  /** Outbox row id (app-generated; the same value travels in the job payload). */
  id: string;
  intentType: NotificationIntent["type"];
  /** Aggregate the intent belongs to (see `notificationAggregateId`). */
  aggregateId: string;
  /** Per-occurrence identity for intents that fire repeatedly; null otherwise. */
  discriminator: string | null;
  /** The full provider-neutral notification intent (immutable). */
  payload: NotificationIntent;
  status: NotificationOutboxStatus;
  attempts: number;
  lastError: string | null;
  /** Queue jobId once relayed (null while pending). */
  jobId: string | null;
  /**
   * Provider-assigned delivery receipt, persisted by the worker via
   * `markDispatched` (null until dispatched, or when the provider returned no
   * id / the send was suppressed). A RECEIPT, never a routing key.
   */
  providerMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
}

export interface AppendNotificationIntentOptions {
  /**
   * Per-occurrence identity (e.g. a tracking event key) that disambiguates
   * repeated intents for the same aggregate. Omit for intents that fire at
   * most once per aggregate.
   */
  discriminator?: string | null;
}

/**
 * Delivery receipt recorded by the notification worker when the provider
 * accepted a dispatch (L8-R PART 2/6). Persisted on the outbox row inside a
 * SHORT transaction that opens only AFTER the provider call resolves.
 */
export interface NotificationDispatchReceipt {
  /**
   * Provider-assigned message id (null when suppressed / no id). Persisted for
   * traceability and reconciliation; it is a receipt, never a routing key.
   */
  providerMessageId: string | null;
  /** The queue jobId that carried this delivery (persisted for traceability). */
  jobId?: string | null;
  /** Delivery time; defaults to the database now() when omitted. */
  dispatchedAt?: string;
}

export interface INotificationOutboxRepository {
  /**
   * Durably record a notification intent. Called INSIDE the producing use
   * case's business transaction; the row commits atomically with the state
   * that produced the intent. A duplicate (intentType, aggregateId,
   * discriminator) append surfaces as a DUPLICATE RepositoryError.
   */
  append(
    id: string,
    intent: NotificationIntent,
    options?: AppendNotificationIntentOptions,
  ): Promise<void>;

  /** Oldest pending rows (ascending createdAt), bounded by `limit`. */
  findPending(limit: number): Promise<NotificationOutboxRecord[]>;

  /** Resolve a row by its durable identity (the worker's reconciliation key). */
  findById(id: string): Promise<NotificationOutboxRecord | null>;

  /**
   * Record that a queue job was accepted for the row. ONLY transitions
   * `pending` -> `queued`; matching an already-relayed or terminal row is a
   * no-op (never resurrects, never rewrites a jobId).
   */
  markQueued(id: string, jobId: string): Promise<void>;

  /**
   * Record a successful provider dispatch (idempotent). ONLY transitions
   * `pending` | `queued` -> `dispatched` (terminal): an already-dispatched row
   * is a no-op and a `failed` row is NEVER resurrected. Persists the delivery
   * receipt (provider message id + job id) inside the caller's short
   * transaction, which opens only AFTER the provider call resolves.
   */
  markDispatched(id: string, receipt?: NotificationDispatchReceipt): Promise<void>;

  /**
   * Record a terminal delivery failure. ONLY transitions `pending` | `queued`
   * -> `failed` (terminal): an already-failed row keeps its original failure
   * and a delivered row is never failed.
   */
  markFailed(id: string, reason: string, attempts?: number): Promise<void>;
}