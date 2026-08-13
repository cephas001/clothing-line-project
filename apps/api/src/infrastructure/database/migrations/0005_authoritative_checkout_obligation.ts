// apps/api/src/infrastructure/database/migrations/0005_authoritative_checkout_obligation.ts
//
// Phase 1 — durable, authoritative financial obligation.
//
// The core invariant this migration establishes: the amount and currency are
// computed authoritatively by the application and persisted durably BEFORE any
// payment processing. The `payment` row is the single source of financial truth
// for a charge; the `order` snapshots it at finalization so its history never
// depends on today's product prices, regional pricing, promotions, or taxes.
//
//   - `payment.*_minor` (subtotal, discount, tax, shipping, insurance) — the
//     authoritative server-computed breakdown of the charge. `amount_minor`
//     must equal `subtotal - discount + tax + shipping + insurance`; the
//     Payment entity validates this invariant on every construction. Existing
//     rows are backfilled to `subtotal_minor = amount_minor` (discount/tax/
//     shipping/insurance = 0) so the invariant holds for pre-existing
//     obligations.
//
//   - `order.currency` + `order.*_minor` — the frozen financial snapshot of the
//     order. Copied from the durable payment at finalization so the order
//     records exactly what was charged and in which currency. Existing rows are
//     backfilled to `subtotal_minor = total_minor`.
//
//   - `cart.shipping_amount_minor` / `cart.shipping_service_level` /
//     `cart.insurance_amount_minor` — durable homes for the server-selected
//     shipping quote and the server-computed insurance premium. The checkout
//     total reads ONLY these durable values (never a client-supplied amount).
//
// Money is stored as BIGINT minor units (Kobo/cents) per the existing schema
// convention. Down migration reverses all additions.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // ---------------------------------------------------------------------------
  // payment — authoritative financial breakdown of the obligation
  // ---------------------------------------------------------------------------
  await db.schema
    .alterTable("payment")
    .addColumn("subtotal_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("discount_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("tax_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("shipping_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("insurance_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .execute();

  // Backfill: existing obligations are a plain charge of their recorded amount.
  await db.updateTable("payment").set({ subtotal_minor: sql`amount_minor` }).execute();

  // ---------------------------------------------------------------------------
  // order — frozen financial snapshot (currency + breakdown)
  // ---------------------------------------------------------------------------
  await db.schema
    .alterTable("order")
    .addColumn("currency", "text")
    .addColumn("subtotal_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("discount_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("tax_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("shipping_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("insurance_minor", "bigint", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .execute();

  // Backfill: existing orders were a plain charge of their recorded total.
  await db.updateTable("order").set({ subtotal_minor: sql`total_minor` }).execute();

  // ---------------------------------------------------------------------------
  // cart — durable server-side shipping + insurance amounts
  // ---------------------------------------------------------------------------
  await db.schema
    .alterTable("cart")
    .addColumn("shipping_amount_minor", "bigint")
    .addColumn("shipping_service_level", "text")
    .addColumn("insurance_amount_minor", "bigint")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("cart")
    .dropColumn("insurance_amount_minor")
    .dropColumn("shipping_service_level")
    .dropColumn("shipping_amount_minor")
    .execute();

  await db.schema
    .alterTable("order")
    .dropColumn("insurance_minor")
    .dropColumn("shipping_minor")
    .dropColumn("tax_minor")
    .dropColumn("discount_minor")
    .dropColumn("subtotal_minor")
    .dropColumn("currency")
    .execute();

  await db.schema
    .alterTable("payment")
    .dropColumn("insurance_minor")
    .dropColumn("shipping_minor")
    .dropColumn("tax_minor")
    .dropColumn("discount_minor")
    .dropColumn("subtotal_minor")
    .execute();
}
