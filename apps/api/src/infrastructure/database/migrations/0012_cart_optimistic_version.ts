// apps/api/src/infrastructure/database/migrations/0012_cart_optimistic_version.ts
//
// PART 25 (L4) — CONCURRENT CART SAVE / RESET RACE CORRECTION.
//
// Cart mutation use cases follow read-modify-write: findById() hydrates the
// aggregate OUTSIDE a transaction, then save() upserts the ENTIRE aggregate
// (all columns + delete/reinsert of cart_line_item) inside its own unit of
// work. Two concurrent requests that both hydrated the same DB state therefore
// overwrite each other's changes (lost update) — e.g. a cart mutation can wipe
// `payment_initialized` set moments earlier by payment initialization, or a
// reset can be reverted by a stale cart save.
//
// This migration adds an optimistic-lock `version` column (integer, default 0),
// mirroring the product_variant.version convention already in the schema. The
// PostgresCartRepository.save() guards its conflict-update with
// `WHERE version = <version the aggregate was loaded with>` and bumps the
// written version on every mutation; a stale writer updates 0 rows and is
// rejected with RepositoryErrorCode.LOCKED (use cases map it to the retryable
// LOCK_ACQUISITION_FAILED domain error). This corrects the race WITHOUT moving
// cart reads into transactions and WITHOUT any provider knowledge in the
// domain.
//
// Down drops the column. Existing migration history is untouched.

import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("cart")
    .addColumn("version", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("cart").dropColumn("version").execute();
}
