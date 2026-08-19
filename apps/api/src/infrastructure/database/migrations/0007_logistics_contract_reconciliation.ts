// apps/api/src/infrastructure/database/migrations/0007_logistics_contract_reconciliation.ts
//
// Contract reconciliation for the Shipbubble (L1) logistics integration. L1
// reported three blocking gaps: shipment creation lacked receiver/parcel data
// and a provider request_token; cancellation and return labels lacked the
// provider shipment id. This migration introduces the minimum persistence to
// close those gaps at the contract level:
//
//   - cart.shipping_request_token / shipping_courier_id / shipping_service_code
//     — the provider request_token and the APPLICATION-selected quote's courier
//     + service, persisted on the checkout aggregate between rate fetching and
//     checkout (mirrors the existing shipping_amount_minor /
//     shipping_service_level scalar convention).
//
//   - order.shipping_snapshot (jsonb) — the frozen provider-neutral shipping
//     snapshot (destination, parcel items, selected quote, request_token)
//     recorded at checkout, so dispatch and return flows are self-contained and
//     never depend on the mutable cart.
//
//   - fulfillment.provider_shipment_id — Shipbubble's provider order id
//     (e.g. "SB-...") as a first-class, queryable external identity for
//     cancellation and return-label flows. NEVER the application orderId.
//
// Down reverses all additions. Existing migration history is untouched.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("cart")
    .addColumn("shipping_request_token", "text")
    .execute();

  await db.schema
    .alterTable("cart")
    .addColumn("shipping_courier_id", "text")
    .execute();

  await db.schema
    .alterTable("cart")
    .addColumn("shipping_service_code", "text")
    .execute();

  await db.schema
    .alterTable("order")
    .addColumn(
      "shipping_snapshot",
      "jsonb",
      (col) => col.defaultTo(sql`'{}'::jsonb`),
    )
    .execute();

  await db.schema
    .alterTable("fulfillment")
    .addColumn("provider_shipment_id", "text")
    .execute();

  await db.schema
    .createIndex("fulfillment_provider_shipment_id_idx")
    .on("fulfillment")
    .column("provider_shipment_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex("fulfillment_provider_shipment_id_idx")
    .on("fulfillment")
    .execute();

  await db.schema
    .alterTable("fulfillment")
    .dropColumn("provider_shipment_id")
    .execute();

  await db.schema
    .alterTable("order")
    .dropColumn("shipping_snapshot")
    .execute();

  await db.schema
    .alterTable("cart")
    .dropColumn("shipping_service_code")
    .execute();

  await db.schema
    .alterTable("cart")
    .dropColumn("shipping_courier_id")
    .execute();

  await db.schema
    .alterTable("cart")
    .dropColumn("shipping_request_token")
    .execute();
}
