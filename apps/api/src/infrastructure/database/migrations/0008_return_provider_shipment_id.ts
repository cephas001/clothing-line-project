// apps/api/src/infrastructure/database/migrations/0008_return_provider_shipment_id.ts
//
// Gives return authorizations a first-class, queryable provider shipment id for
// the RETURN label (e.g. Shipbubble "SB-..."). The OUTBOUND identity lives on
// fulfillment.provider_shipment_id; the return label's identity is a separate
// value persisted here so the two never collide or overwrite each other. NEVER
// the application orderId.
//
// Down reverses all additions. Existing migration history is untouched.

import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("return_authorization")
    .addColumn("provider_shipment_id", "text")
    .execute();

  await db.schema
    .createIndex("return_authorization_provider_shipment_id_idx")
    .on("return_authorization")
    .column("provider_shipment_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex("return_authorization_provider_shipment_id_idx")
    .on("return_authorization")
    .execute();

  await db.schema
    .alterTable("return_authorization")
    .dropColumn("provider_shipment_id")
    .execute();
}