// apps/api/src/infrastructure/database/migrations/0020_product_media.ts
//
// F4 PRE-IMPLEMENTATION (M1) — PRODUCT MEDIA REFERENCES.
//
// The storefront renders product images today from a hardcoded local array
// (empty in the demo); the OpenAPI `Product` DTO exposes no image/media
// information. This migration adds the minimal additive persistence for media
// REFERENCES (never binaries): a `product_media` table keyed by product, with
// a stable ordering column and an optional alt-text. URLs point at whatever the
// catalog stores them as (the dev seed uses relative asset paths; production
// may use a CDN). There is deliberately NO media upload/storage subsystem here
// — the DB stores metadata only.
//
//   - `product_id` FK -> product.id with ON DELETE CASCADE (mirrors the
//     product_category / product_sales_channel join conventions from 0002).
//   - `sort_order` is the deterministic display order; a (product_id,
//     sort_order) composite index keeps ordered reads cheap.
//
// ADDITIVE + IDEMPOTENT: the table is new; nothing existing is altered. Down
// reverses only this migration's additions.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("product_media")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("product_id", "text", (col) =>
      col.references("product.id").onDelete("cascade").notNull(),
    )
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) =>
      col.notNull().defaultTo(sql`'image'`),
    )
    .addColumn("alt_text", "text")
    .addColumn("sort_order", "integer", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .execute();

  await db.schema
    .createIndex("product_media_product_sort_idx")
    .on("product_media")
    .columns(["product_id", "sort_order"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex("product_media_product_sort_idx")
    .on("product_media")
    .execute();
  await db.schema.dropTable("product_media").execute();
}