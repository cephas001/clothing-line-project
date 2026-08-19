// apps/api/src/infrastructure/database/migrations/0014_notification_outbox.ts
//
// L8 — DURABLE NOTIFICATION OUTBOX (PARTS 2/3).
//
// Notification reliability for INTERNAL triggers (order finalized, quote
// approved, draft order invoiced, courier tracking advances). Unlike payment
// and logistics webhooks — which are re-delivered by the provider — these
// intents exist only in local state: a crash between the business COMMIT and
// the queue ENQUEUE would otherwise permanently lose the notification.
// `notification_outbox` closes that window: the producing use case appends a
// row inside its OWN business transaction (no provider call inside the
// transaction), and `EnqueuePendingNotificationsUseCase` relays pending rows
// to `notification-events-queue` afterwards.
//
// Deduplication is enforced at the DATABASE: a UNIQUE index on
// (intent_type, aggregate_id, COALESCE(discriminator, '')) means the same
// logical notification can never be appended twice (Postgres treats NULLs as
// distinct in unique indexes, hence COALESCE to '' for intents without a
// discriminator). `aggregate_id` is the intent's stable aggregate
// (see `notificationAggregateId`); `discriminator` disambiguates
// per-occurrence intents such as repeated courier tracking updates.
//
// `status` lifecycle: pending -> queued -> dispatched | failed. Rows are only
// ever `failed` by the worker after exhaustive BullMQ retries (terminal), so
// the sweep can never spin on a poison row.
//
// Down drops the table (the audit log — the durable source of record — is not
// affected).

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("notification_outbox")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("intent_type", "text", (col) => col.notNull())
    .addColumn("aggregate_id", "text", (col) => col.notNull())
    .addColumn("discriminator", "text")
    .addColumn("payload", "jsonb", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_error", "text")
    .addColumn("job_id", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("dispatched_at", "timestamptz")
    .execute();

  // Deterministic logical-notification identity. COALESCE '' makes the
  // discriminator part of the key even when NULL (Postgres unique indexes
  // treat NULLs as distinct).
  await sql`CREATE UNIQUE INDEX notification_outbox_intent_unique ON notification_outbox (intent_type, aggregate_id, COALESCE(discriminator, ''))`.execute(
    db,
  );

  // The relay sweeps oldest-pending first, bounded.
  await db.schema
    .createIndex("notification_outbox_pending_idx")
    .on("notification_outbox")
    .columns(["status", "created_at"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("notification_outbox_pending_idx").execute();
  await sql`DROP INDEX IF EXISTS notification_outbox_intent_unique`.execute(db);
  await db.schema.dropTable("notification_outbox").execute();
}