// apps/api/tests/fakes/InMemoryNotificationOutboxRepository.ts
//
// In-memory INotificationOutboxRepository that FAITHFULLY mirrors the database
// guards (migrations 0014 + 0015):
//
//   - UNIQUE(intent_type, aggregate_id, COALESCE(discriminator, '')) — the same
//     logical notification can never be appended twice; a collision surfaces
//     RepositoryErrorCode.DUPLICATE.
//   - Status state machine (L8-R PART 5): pending --markQueued--> queued
//     --markDispatched--> dispatched (terminal); pending | queued
//     --markFailed--> failed (terminal). A transition outside the machine is a
//     no-op, so a `failed` row is never resurrected and a `dispatched` row is
//     never re-dispatched or failed.
//
// `append` inserts a row; `findPending` returns rows in createdAt order;
// `findById` resolves a row by its durable identity; `markQueued` /
// `markDispatched` / `markFailed` drive the guarded status lifecycle.
// `rows` exposes the raw records for assertions (e.g. the payment-confirmation
// and refund-issued suites assert exactly one intent per logical event).

import type {
  AppendNotificationIntentOptions,
  INotificationOutboxRepository,
  NotificationDispatchReceipt,
  NotificationOutboxRecord,
  NotificationOutboxStatus,
} from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import type { NotificationIntent } from "@api/domain/shared/notifications";
import {
  notificationAggregateId,
} from "@api/domain/shared/notifications";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryNotificationOutboxRepository
  implements INotificationOutboxRepository, Snapshotable
{
  private readonly records = new Map<string, NotificationOutboxRecord>();

  get rows(): NotificationOutboxRecord[] {
    return [...this.records.values()];
  }

  async append(
    id: string,
    intent: NotificationIntent,
    options?: AppendNotificationIntentOptions,
  ): Promise<void> {
    const intentType = intent.type;
    const aggregateId = notificationAggregateId(intent);
    const discriminator = options?.discriminator ?? null;

    const existing = [...this.records.values()].find(
      (r) =>
        r.intentType === intentType &&
        r.aggregateId === aggregateId &&
        (r.discriminator ?? null) === discriminator,
    );
    if (existing) {
      throw this.duplicate(
        `UNIQUE(intent_type, aggregate_id, COALESCE(discriminator,'')) violated for ${intentType}/${aggregateId}/${discriminator}.`,
      );
    }

    const now = new Date().toISOString();
    this.records.set(id, {
      id,
      intentType,
      aggregateId,
      discriminator,
      payload: intent,
      status: "pending",
      attempts: 0,
      lastError: null,
      jobId: null,
      providerMessageId: null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
    });
  }

  async findPending(limit: number): Promise<NotificationOutboxRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .slice(0, limit)
      .map((r) => ({ ...r, payload: r.payload }));
  }

  async findById(id: string): Promise<NotificationOutboxRecord | null> {
    const record = this.records.get(id);
    return record ? { ...record, payload: record.payload } : null;
  }

  async markQueued(id: string, jobId: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.status !== "pending") {
      return;
    }
    record.status = "queued";
    record.jobId = jobId;
    record.updatedAt = new Date().toISOString();
  }

  async markDispatched(
    id: string,
    receipt?: NotificationDispatchReceipt,
  ): Promise<void> {
    const record = this.records.get(id);
    if (
      !record ||
      (record.status !== "pending" && record.status !== "queued")
    ) {
      return;
    }
    record.status = "dispatched";
    if (receipt?.providerMessageId !== undefined) {
      record.providerMessageId = receipt.providerMessageId;
    }
    if (receipt?.jobId !== undefined) {
      record.jobId = receipt.jobId;
    }
    record.dispatchedAt = receipt?.dispatchedAt ?? new Date().toISOString();
    record.updatedAt = new Date().toISOString();
  }

  async markFailed(
    id: string,
    reason: string,
    attempts?: number,
  ): Promise<void> {
    const record = this.records.get(id);
    if (
      !record ||
      (record.status !== "pending" && record.status !== "queued")
    ) {
      return;
    }
    record.status = "failed" as NotificationOutboxStatus;
    record.lastError = reason;
    record.attempts = attempts ?? record.attempts + 1;
    record.updatedAt = new Date().toISOString();
  }

  snapshot(): unknown {
    return cloneValue(this.rows);
  }

  restore(state: unknown): void {
    this.records.clear();
    for (const record of state as NotificationOutboxRecord[]) {
      this.records.set(record.id, record);
    }
  }

  private duplicate(message: string): RepositoryError {
    const error = new Error(message) as RepositoryError;
    error.name = "RepositoryError";
    error.code = RepositoryErrorCode.DUPLICATE;
    return error;
  }
}