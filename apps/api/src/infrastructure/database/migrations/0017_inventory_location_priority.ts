// apps/api/src/infrastructure/database/migrations/0017_inventory_location_priority.ts
//
// L9 — INVENTORY / SOURCING CAPABILITY: DETERMINISTIC SOURCING PRIORITY.
//
// L9 sourcing MUST be deterministic and MUST NOT depend on the caller's
// coordinates or a split plan. The preferred-origin rule is expressed locally:
// `inventory_location.priority` (nullable integer, LOWER = MORE PREFERRED)
// becomes the first sort key of the single-origin selection. Ops-configured
// locations that supply a priority always outrank the un-prioritized legacy
// seed node (`loc-default`, priority NULL), so the system naturally sources
// from a real configured node once one exists.
//
// ADDITIVE + IDEMPOTENT: the column is nullable (no backfill, no default), so
// every pre-existing location — including the seed — stays valid and the
// ordering rule falls back to (priority NULLS LAST, code ASC, id ASC). Down
// reverses only this migration's additions.

import { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Lower priority value = more preferred origin. NULL (legacy/seed nodes) sort
  // LAST, so configured nodes always win while un-prioritized rows remain valid.
  await db.schema
    .alterTable("inventory_location")
    .addColumn("priority", "integer")
    .execute();

  // Deterministic sourcing scans the active locations ordered by (priority,
  // code); index the two sort keys together.
  await db.schema
    .createIndex("inventory_location_priority_code_idx")
    .on("inventory_location")
    .columns(["priority", "code"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex("inventory_location_priority_code_idx")
    .on("inventory_location")
    .execute();
  await db.schema
    .alterTable("inventory_location")
    .dropColumn("priority")
    .execute();
}