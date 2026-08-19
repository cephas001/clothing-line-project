// apps/api/src/infrastructure/database/migrations/0006_initialization_pending_state.ts
//
// Introduces the explicit INITIALIZATION_PENDING state for durable payment
// obligations.
//
// Ordering guarantee: the payment obligation is durably claimed BEFORE the
// gateway is contacted (PostgreSQL transactions cannot span an external HTTP
// call). Previously `initialized` doubled as both "claimed" and "gateway
// accepted". This migration normalizes the ambiguous rows — obligations
// recorded as `initialized` that never received a provider payment URL (the
// gateway call never completed, or its result was never persisted) — to the
// honest `initialization_pending` state. The domain invariant that a payment is
// `initialized` if and only if it carries a provider payment URL then holds
// from the start.
//
// New obligations are written as `initialization_pending` by the application
// and transition to `initialized` only once the gateway accepts them and the
// provider URL is persisted. The status column is unconstrained text, so this
// is a pure data migration — no schema change is required.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db
    .updateTable("payment")
    .set({ status: "initialization_pending", updated_at: sql`now()` })
    .where("status", "=", "initialized")
    .where("provider_payment_url", "is", null)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Intentionally a no-op: after this migration, rows that were backfilled are
  // indistinguishable from rows that were always genuinely pending, so the
  // migration cannot be reversed without corrupting the state model.
}
