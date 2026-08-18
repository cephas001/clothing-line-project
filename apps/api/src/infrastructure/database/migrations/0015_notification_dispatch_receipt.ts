// apps/api/src/infrastructure/database/migrations/0015_notification_dispatch_receipt.ts
//
// L8-R — DURABLE DELIVERY RECEIPT ON THE NOTIFICATION OUTBOX (PART 2/6).
//
// The notification worker relays a `notification-events-queue` job to the
// provider OUTSIDE any DB transaction (invariant: no provider call inside a
// transaction), then persists the delivery receipt on the outbox row in a
// SHORT local transaction. `provider_message_id` is that receipt — the
// provider-assigned message id used for traceability and reconciliation, never
// for re-sending. `job_id` (added in 0014) is already overwritten by the
// worker at dispatch time so a row delivered in the relay crash window (a job
// exists before `markQueued` lands) still records which job carried it.
//
// Nullable: suppressed sends (recipient preference) and providers without an id
// record a NULL receipt, which is a valid terminal `dispatched` state.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("notification_outbox")
    .addColumn("provider_message_id", "text")
    .execute();

  await sql`UPDATE notification_outbox SET provider_message_id = NULL WHERE provider_message_id IS NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("notification_outbox")
    .dropColumn("provider_message_id")
    .execute();
}