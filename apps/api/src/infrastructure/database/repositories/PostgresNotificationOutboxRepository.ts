// apps/api/src/infrastructure/database/repositories/PostgresNotificationOutboxRepository.ts

// Postgres-backed implementation of INotificationOutboxRepository (L8).
//
// `append` writes the full provider-neutral NotificationIntent as JSONB and is
// meant to run INSIDE the producing use case's business transaction (the
// TransactionContext resolves the active transaction when present, so the row
// commits atomically with the state that produced the notification). The
// deterministic (intent_type, aggregate_id, COALESCE(discriminator, ''))
// unique index rejects duplicate logical notifications with a unique_violation
// that toRepositoryError maps to RepositoryErrorCode.DUPLICATE.
//
// `findPending` runs on the pooled connection (no transaction), so the relay
// sweep never holds a long-lived transaction open. `findById` (the worker's
// reconciliation key) also runs on the pooled connection — the worker resolves
// the committed row, calls the provider OUTSIDE any transaction, and only then
// opens a short transaction to persist the dispatch receipt.
//
// STATUS STATE MACHINE (L8-R PART 5) — enforced by the guarded WHERE clauses:
//   pending --markQueued--> queued --markDispatched--> dispatched (terminal)
//   pending | queued --markFailed--> failed (terminal)
// A guarded transition that matches zero rows is a no-op, so a concurrent
// sweep/worker can never resurrect a `failed` row, re-deliver a `dispatched`
// row, or fail an already-delivered row.

import type { INotificationOutboxRepository } from "@api-domain-interfaces/repositories/INotificationOutboxRepository";
import type {
  NotificationOutboxRecord,
  NotificationDispatchReceipt,
  AppendNotificationIntentOptions,
} from "@api-domain-interfaces/repositories/INotificationOutboxRepository";
import {
  notificationAggregateId,
  type NotificationIntent,
} from "@api/domain/shared/notifications";
import { TransactionContext } from "../transaction/TransactionContext";
import { sql } from "kysely";
import { toRepositoryError } from "./errorMapping";

type NotificationOutboxRow = {
  id: string;
  intent_type: string;
  aggregate_id: string;
  discriminator: string | null;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  job_id: string | null;
  provider_message_id: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
};

function toDomain(row: NotificationOutboxRow): NotificationOutboxRecord {
  return {
    id: row.id,
    intentType: row.intent_type as NotificationIntent["type"],
    aggregateId: row.aggregate_id,
    discriminator: row.discriminator,
    payload: row.payload as NotificationIntent,
    status: row.status as NotificationOutboxRecord["status"],
    attempts: row.attempts,
    lastError: row.last_error,
    jobId: row.job_id,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
  };
}

export class PostgresNotificationOutboxRepository
  implements INotificationOutboxRepository
{
  constructor(private readonly context: TransactionContext) {}

  async append(
    id: string,
    intent: NotificationIntent,
    options?: AppendNotificationIntentOptions,
  ): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("notification_outbox")
        .values({
          id,
          intent_type: intent.type,
          aggregate_id: notificationAggregateId(intent),
          discriminator: options?.discriminator ?? null,
          payload: JSON.stringify(intent),
          status: "pending",
          attempts: 0,
          last_error: null,
          job_id: null,
        })
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findPending(limit: number): Promise<NotificationOutboxRecord[]> {
    try {
      const rows = await this.context
        .getDb()
        .selectFrom("notification_outbox")
        .selectAll()
        .where("status", "=", "pending")
        .orderBy("created_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(toDomain);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findById(id: string): Promise<NotificationOutboxRecord | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("notification_outbox")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async markQueued(id: string, jobId: string): Promise<void> {
    try {
      await this.context
        .getDb()
        .updateTable("notification_outbox")
        .set({
          status: "queued",
          job_id: jobId,
          updated_at: sql`now()`,
        })
        .where("id", "=", id)
        .where("status", "=", "pending")
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async markDispatched(
    id: string,
    receipt?: NotificationDispatchReceipt,
  ): Promise<void> {
    try {
      await this.context
        .getDb()
        .updateTable("notification_outbox")
        .set({
          status: "dispatched",
          provider_message_id: receipt?.providerMessageId ?? null,
          job_id: receipt?.jobId ?? sql`notification_outbox.job_id`,
          dispatched_at: receipt?.dispatchedAt ?? sql`now()`,
          updated_at: sql`now()`,
        })
        .where("id", "=", id)
        .where("status", "in", ["pending", "queued"])
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async markFailed(
    id: string,
    reason: string,
    attempts?: number,
  ): Promise<void> {
    try {
      await this.context
        .getDb()
        .updateTable("notification_outbox")
        .set({
          status: "failed",
          last_error: reason,
          attempts: attempts ?? sql`notification_outbox.attempts + 1`,
          updated_at: sql`now()`,
        })
        .where("id", "=", id)
        .where("status", "in", ["pending", "queued"])
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}