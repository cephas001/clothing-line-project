// apps/api/src/infrastructure/database/migrations/0011_fulfillment_dispatch_claim.ts
//
// PART 10 — DUPLICATE / RACE SAFETY FOR DISPATCH (L4).
//
// A single durable dispatch claim per order is enforced at the DATABASE so two
// concurrent dispatch requests can never both POST a shipment to the provider.
//
// The dispatch flow durably claims a fulfillment row as `dispatch_pending`
// BEFORE calling the logistics provider. Without a DB-level arbiter, two racing
// workers would each insert a DIFFERENT `dispatch_pending` row (the id is
// application-generated) and both would POST — producing two provider
// shipments. The use case must NOT solve this by holding a database
// transaction open across the provider HTTP call (PART 5 forbids that).
//
// This migration adds a PARTIAL UNIQUE index on fulfillment(order_id) restricted
// to rows that represent an ACTIVE claim or a CONFIRMED shipment:
//
//   status IN ('dispatch_pending', 'dispatched', 'pending_dispatch')
//
// At most ONE such row can exist per order. The second concurrent insert raises
// a unique_violation (mapped to RepositoryErrorCode.DUPLICATE) that the
// dispatch use case resolves by reloading the order and honouring the winner's
// claim (replay / requires_reconciliation) instead of POSTing again. Terminal
// rows (`failed`, `requires_reconciliation`) are excluded from the predicate so
// the index never blocks the dedicated gate logic that refuses re-dispatch for
// those states. The legacy pre-foundation `pending_dispatch` status is included
// so historical rows are treated as claims too.
//
// Down drops the index (the non-unique fulfillment_order_id_idx remains).

import { Kysely, SqlBool, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex("fulfillment_dispatch_claim_unique")
    .on("fulfillment")
    .column("order_id")
    .where(
      sql<SqlBool>`status IN ('dispatch_pending', 'dispatched', 'pending_dispatch')`,
    )
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("fulfillment_dispatch_claim_unique").execute();
}
