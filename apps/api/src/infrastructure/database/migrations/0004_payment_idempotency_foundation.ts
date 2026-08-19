// apps/api/src/infrastructure/database/migrations/0004_payment_idempotency_foundation.ts
//
// Financial-integrity foundation for the Paystack integration. Addresses the
// confirmed payment defects identified in the audit by making the database the
// final concurrency/idempotency guard for every payment obligation and refund.
//
//   - `payment`  — durable record of each payment obligation (checkout cart,
//     swap upcharge, order-edit due). One row per obligation (UNIQUE on
//     obligation_type + obligation_id), an application-generated idempotency
//     reference (UNIQUE), and the provider reference (UNIQUE when present).
//     The app passes `reference` to the gateway up front, so the same request
//     always resolves to the same row and the same gateway reference; the
//     provider-returned reference is persisted authoritatively in
//     `provider_reference`. This backstops payment-initialization idempotency
//     and swap-payment idempotency at the database.
//
//   - `refund`   — durable, idempotent refund records. A refund is uniquely
//     identified by (provider_transaction_reference, amount_minor) so the same
//     refund request can never be issued twice, plus an application-generated
//     `refund_reference` and the provider's refund reference (UNIQUE when
//     present). `payment_id` optionally links back to the original payment
//     intent for traceability (NULL for pre-foundation/legacy rows).
//
//   - `cart.payment_reference` — durable, queryable payment reference on the
//     primary checkout aggregate, mirroring the durable payment row.
//
//   - `swap.natural_key`       — deterministic business identity of a swap
//     request (order + line item + target variant + quantity). The swap flow
//     generates a fresh swap id per invocation, so idempotency must key on the
//     request identity; UNIQUE(natural_key) makes a re-run of the same swap
//     request collide at the database instead of creating a duplicate swap and
//     a second gateway payment/refund. NULL for pre-existing rows.
//
// Money is stored as BIGINT minor units (Kobo/cents) per the existing schema
// convention. Down migration reverses all additions.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // ---------------------------------------------------------------------------
  // payment — durable payment obligations + provider references
  // ---------------------------------------------------------------------------
  await db.schema
    .createTable("payment")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("obligation_type", "text", (col) => col.notNull())
    .addColumn("obligation_id", "text", (col) => col.notNull())
    .addColumn("reference", "text", (col) => col.notNull().unique())
    .addColumn("provider_reference", "text", (col) => col.unique())
    .addColumn("provider_payment_url", "text")
    .addColumn("amount_minor", "bigint", (col) => col.notNull())
    .addColumn("currency", "text")
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo(sql`'initialized'`),
    )
    .addColumn("metadata", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("payment_obligation_unique", [
      "obligation_type",
      "obligation_id",
    ])
    .execute();

  await db.schema
    .createIndex("payment_provider_reference_idx")
    .on("payment")
    .column("provider_reference")
    .execute();

  // ---------------------------------------------------------------------------
  // refund — durable, idempotent refund records
  // ---------------------------------------------------------------------------
  await db.schema
    .createTable("refund")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("payment_id", "text", (col) => col.references("payment.id"))
    .addColumn("refund_reference", "text", (col) => col.notNull().unique())
    .addColumn("provider_refund_reference", "text", (col) => col.unique())
    .addColumn("provider_transaction_reference", "text", (col) =>
      col.notNull(),
    )
    .addColumn("amount_minor", "bigint", (col) => col.notNull())
    .addColumn("currency", "text")
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo(sql`'pending'`),
    )
    .addColumn("reason", "text")
    .addColumn("metadata", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("refund_transaction_amount_unique", [
      "provider_transaction_reference",
      "amount_minor",
    ])
    .execute();

  await db.schema
    .createIndex("refund_payment_id_idx")
    .on("refund")
    .column("payment_id")
    .execute();

  // ---------------------------------------------------------------------------
  // cart.payment_reference — durable, queryable reference on the cart
  // ---------------------------------------------------------------------------
  await db.schema
    .alterTable("cart")
    .addColumn("payment_reference", "text")
    .execute();

  // ---------------------------------------------------------------------------
  // swap.natural_key — request-identity idempotency for swap creation
  // ---------------------------------------------------------------------------
  await db.schema
    .alterTable("swap")
    .addColumn("natural_key", "text")
    .execute();

  await db.schema
    .createIndex("swap_natural_key_idx")
    .on("swap")
    .column("natural_key")
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("refund").execute();
  await db.schema.dropTable("payment").execute();
  await db.schema.alterTable("cart").dropColumn("payment_reference").execute();
  await db.schema.alterTable("swap").dropColumn("natural_key").execute();
}