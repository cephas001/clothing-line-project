// apps/api/src/infrastructure/database/migrations/0018_order_sourcing_snapshot.ts
//
// L9 — INVENTORY / SOURCING CAPABILITY: FROZEN ORDER SOURCING SNAPSHOT.
//
// At finalization the order freezes the provider-neutral sourcing snapshot
// (which locations held the reserved units that became the order, the primary
// fulfillment location, and the shipment origin resolved from that location's
// LOCAL sender record). That snapshot makes dispatch/RMA flows self-contained:
// they never depend on the mutable inventory tables or a logistics-provider
// decision. This migration adds the single nullable JSONB column that carries
// the snapshot.
//
// ADDITIVE + IDEMPOTENT: the column is nullable with no backfill or default,
// so every pre-existing order row stays valid (legacy orders simply carry no
// sourcing snapshot and dispatch degrades). Down reverses only this
// migration's addition.

import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("order")
    .addColumn("sourcing_snapshot", "jsonb")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("order")
    .dropColumn("sourcing_snapshot")
    .execute();
}