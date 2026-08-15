// apps/api/src/infrastructure/database/migrations/0010_checkout_payment_attempt_reset.ts
//
// CLOSES THE L3 PAYMENT-FAILURE GAP: permits a NEW checkout obligation after a
// genuinely failed/abandoned gateway initialization WITHOUT deleting the
// previous Payment row and WITHOUT clearing payment history.
//
// The original `payment_obligation_unique` UNIQUE(obligation_type,
// obligation_id) allowed exactly ONE obligation per cart forever. Combined
// with the deterministic reference `CLP-checkout-<cartId>` (UNIQUE(reference)),
// that made a post-failure retry impossible without either reusing the same row
// (re-asking the gateway for a reference that already produced a possibly
// different-amount transaction — unsafe retry semantics) or deleting history.
//
// This migration is the DELIBERATE resolution, not a silent weakening:
//   - UNIQUE(reference)  is PRESERVED (one row per app idempotency key).
//   - UNIQUE(provider_reference) is PRESERVED (one provider transaction).
//   - The obligation uniqueness becomes a PARTIAL unique index that forbids
//     more than one ACTIVE obligation per cart but permits a fresh row once
//     the prior obligation has been marked `failed` (a terminal, non-settled
//     state reached ONLY through the reset use case). Settled states
//     (captured/refunded/partially_refunded) still collide, so a settled cart
//     can never acquire a second obligation.
//
// The application derives a deterministic per-attempt reference from the count
// of failed obligations, so each retry resolves to its OWN row and its OWN
// gateway transaction while `CLP-checkout-<cartId>` (attempt 0) stays
// backward-compatible with existing rows.

import { Kysely, SqlBool, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("payment")
    .dropConstraint("payment_obligation_unique")
    .execute();

  await db.schema
    .createIndex("payment_obligation_active_unique")
    .on("payment")
    .columns(["obligation_type", "obligation_id"])
    .where(sql<SqlBool>`status <> 'failed'`)
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("payment_obligation_active_unique").execute();

  await db.schema
    .alterTable("payment")
    .addUniqueConstraint("payment_obligation_unique", [
      "obligation_type",
      "obligation_id",
    ])
    .execute();
}
