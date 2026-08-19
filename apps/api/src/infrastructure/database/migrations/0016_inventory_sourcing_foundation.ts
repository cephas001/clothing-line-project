// apps/api/src/infrastructure/database/migrations/0016_inventory_sourcing_foundation.ts
//
// L9 — INVENTORY / SOURCING CAPABILITY: DB FOUNDATION.
//
// The pre-L9 model keeps a SINGLE global, mutable `product_variant
// .inventory_quantity` with optimistic versioning enforced ONLY in the domain
// entity (the PostgresVariantRepository.save upsert does not gate on `version`
// and the DB has no non-negativity guard). There is no durable location,
// reservation, or sourcing concept; `IInventoryLocationService` (the sourcing
// adapter) is an unwired external-service placeholder. This migration is the
// minimal additive schema that makes the DATABASE the final concurrency and
// integrity guard for the L9 inventory/sourcing capability:
//
//   1. `inventory_location` — the authoritative fulfillment/sourcing node
//      registry. The LOCAL sender/origin record is the source of truth for a
//      node's shipment origin (Shipbubble NEVER becomes the source of truth);
//      `provider_address_code` is an adapter-owned cache of the provider's
//      validated code, never a business input.
//
//   2. `inventory_level` — per-(variant, location) stock ledger. The mutable
//      counters (available_quantity / reserved_quantity) carry DB CHECKs that
//      make NEGATIVE STOCK IMPOSSIBLE no matter which code path writes, and the
//      UNIQUE(variant_id, location_id) makes exactly ONE authoritative level
//      per node. `version` is the optimistic-lock counter for future
//      repositories (mirroring `product_variant.version`).
//
//   3. `inventory_reservation` — durable reservation ledger. `reservation_key`
//      is UNIQUE (app-generated idempotency key), so a retried/concurrent
//      duplicate reservation request collides and the whole unit of work rolls
//      back instead of double-reserving.
//
//   4. `product_variant.inventory_quantity >= 0` CHECK — the final guard for
//      the EXISTING global column (the domain already enforces this; the DB now
//      proves it for every writer).
//
//   5. `fulfillment.sourcing_location_id` — nullable link to the node that
//      actually fulfilled an order, so the provider-neutral dispatch flow can
//      resolve the shipment origin FROM the local location record (never
//      reconstructed from Shipbubble).
//
// CONCURRENCY PROOF — two concurrent buyers cannot reserve the same final unit:
//   Reserve = (inside ITransactionManager, row-locked by the UPDATE)
//     UPDATE inventory_level
//        SET available_quantity = available_quantity - :qty,
//            reserved_quantity   = reserved_quantity   + :qty,
//            version             = version             + 1
//      WHERE variant_id = :variantId AND location_id = :locationId
//        AND available_quantity >= :qty
//   Postgres serializes the two transactions on the row; the loser re-evaluates
//   the WHERE against the winner's committed decrement and updates ZERO rows.
//   A zero-row result means insufficient availability (OUT_OF_STOCK) — the
//   CHECK(available_quantity >= 0) makes oversell structurally impossible. The
//   UNIQUE(reservation_key) insert of the reservation record (same unit of
//   work) then makes a duplicate logical reservation collide and roll back,
//   proving idempotency at the database.
//
// ADDITIVE + IDEMPOTENT: every object is new; nothing existing is dropped or
// altered destructively. The seed default location and the inventory_level
// backfill use ON CONFLICT DO NOTHING so re-runs / partial replays are no-ops.
// Down reverses only this migration's additions.

import { Kysely, sql } from "kysely";

const DEFAULT_LOCATION_ID = "loc-default";
const DEFAULT_LOCATION_CODE = "DEFAULT";

export async function up(db: Kysely<any>): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. Inventory / fulfillment locations (authoritative node + origin registry)
  // ---------------------------------------------------------------------------

  await db.schema
    .createTable("inventory_location")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("code", "text", (col) => col.notNull().unique())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("is_active", "boolean", (col) =>
      col.notNull().defaultTo(sql`true`),
    )
    .addColumn(
      "sender_address",
      "jsonb",
      (col) => col.defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("provider_address_code", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("inventory_location_code_idx")
    .on("inventory_location")
    .column("code")
    .execute();

  // Seed the single default node so pre-L9 global stock has a location to map
  // to and existing queries against per-location levels are never empty.
  await db
    .insertInto("inventory_location")
    .values({
      id: DEFAULT_LOCATION_ID,
      code: DEFAULT_LOCATION_CODE,
      name: "Default Fulfillment Location",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  // ---------------------------------------------------------------------------
  // 2. Per-location stock ledger with DB-enforced non-negative invariants
  // ---------------------------------------------------------------------------

  await db.schema
    .createTable("inventory_level")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("variant_id", "text", (col) =>
      col.references("product_variant.id").notNull(),
    )
    .addColumn("location_id", "text", (col) =>
      col.references("inventory_location.id").notNull(),
    )
    .addColumn("available_quantity", "integer", (col) => col.notNull())
    .addColumn("reserved_quantity", "integer", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("version", "integer", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("inventory_level_variant_location_unique", [
      "variant_id",
      "location_id",
    ])
    .execute();

  // The FINAL no-negative-stock guards: a bug that bypasses the domain can
  // never persist a negative available or reserved quantity.
  await db.schema
    .alterTable("inventory_level")
    .addCheckConstraint(
      "inventory_level_available_nonnegative_check",
      sql`available_quantity >= 0`,
    )
    .execute();
  await db.schema
    .alterTable("inventory_level")
    .addCheckConstraint(
      "inventory_level_reserved_nonnegative_check",
      sql`reserved_quantity >= 0`,
    )
    .execute();

  await db.schema
    .createIndex("inventory_level_variant_id_idx")
    .on("inventory_level")
    .column("variant_id")
    .execute();
  await db.schema
    .createIndex("inventory_level_location_id_idx")
    .on("inventory_level")
    .column("location_id")
    .execute();

  // Backfill: mirror every existing variant's global stock onto the default
  // location so per-location availability is consistent with legacy data.
  // Deterministic ids + ON CONFLICT DO NOTHING keep the backfill idempotent.
  await sql`
    INSERT INTO inventory_level (id, variant_id, location_id, available_quantity, reserved_quantity, version)
    SELECT concat('default-', pv.id), pv.id, ${DEFAULT_LOCATION_ID}, pv.inventory_quantity, 0, 0
    FROM product_variant pv
    ON CONFLICT (variant_id, location_id) DO NOTHING
  `.execute(db);

  // ---------------------------------------------------------------------------
  // 3. Durable reservation ledger (idempotent, DB-arbitrated)
  // ---------------------------------------------------------------------------

  await db.schema
    .createTable("inventory_reservation")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn(
      "reservation_key",
      "text",
      (col) => col.notNull().unique(),
    )
    .addColumn("location_id", "text", (col) =>
      col.references("inventory_location.id").notNull(),
    )
    .addColumn("variant_id", "text", (col) =>
      col.references("product_variant.id").notNull(),
    )
    .addColumn("quantity", "integer", (col) => col.notNull())
    .addColumn("status", "text", (col) =>
      col.notNull().defaultTo(sql`'pending'`),
    )
    .addColumn("order_id", "text", (col) => col.references("order.id"))
    .addColumn("expires_at", "timestamptz")
    .addColumn("version", "integer", (col) =>
      col.notNull().defaultTo(sql`0`),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Reservation quantities are whole positive units; never zero/negative.
  await db.schema
    .alterTable("inventory_reservation")
    .addCheckConstraint(
      "inventory_reservation_quantity_positive_check",
      sql`quantity > 0`,
    )
    .execute();

  await db.schema
    .createIndex("inventory_reservation_location_variant_idx")
    .on("inventory_reservation")
    .columns(["location_id", "variant_id"])
    .execute();
  // Expiry sweeps scan by (status, expires_at).
  await db.schema
    .createIndex("inventory_reservation_status_expiry_idx")
    .on("inventory_reservation")
    .columns(["status", "expires_at"])
    .execute();

  // ---------------------------------------------------------------------------
  // 4. Final guard for the EXISTING global stock column
  // ---------------------------------------------------------------------------

  await db.schema
    .alterTable("product_variant")
    .addCheckConstraint(
      "product_variant_inventory_nonnegative_check",
      sql`inventory_quantity >= 0`,
    )
    .execute();

  // ---------------------------------------------------------------------------
  // 5. Record which location actually fulfilled an order (origin resolution)
  // ---------------------------------------------------------------------------

  await db.schema
    .alterTable("fulfillment")
    .addColumn("sourcing_location_id", "text", (col) =>
      col.references("inventory_location.id"),
    )
    .execute();

  await db.schema
    .createIndex("fulfillment_sourcing_location_id_idx")
    .on("fulfillment")
    .column("sourcing_location_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex("fulfillment_sourcing_location_id_idx")
    .on("fulfillment")
    .execute();
  await db.schema
    .alterTable("fulfillment")
    .dropColumn("sourcing_location_id")
    .execute();

  await db.schema
    .alterTable("product_variant")
    .dropConstraint("product_variant_inventory_nonnegative_check")
    .execute();

  await db.schema
    .dropIndex("inventory_reservation_status_expiry_idx")
    .on("inventory_reservation")
    .execute();
  await db.schema
    .dropIndex("inventory_reservation_location_variant_idx")
    .on("inventory_reservation")
    .execute();
  await db.schema
    .alterTable("inventory_reservation")
    .dropConstraint("inventory_reservation_quantity_positive_check")
    .execute();
  await db.schema.dropTable("inventory_reservation").execute();

  await db.schema
    .dropIndex("inventory_level_location_id_idx")
    .on("inventory_level")
    .execute();
  await db.schema
    .dropIndex("inventory_level_variant_id_idx")
    .on("inventory_level")
    .execute();
  await db.schema
    .alterTable("inventory_level")
    .dropConstraint("inventory_level_reserved_nonnegative_check")
    .execute();
  await db.schema
    .alterTable("inventory_level")
    .dropConstraint("inventory_level_available_nonnegative_check")
    .execute();
  await db.schema.dropTable("inventory_level").execute();

  await db.schema
    .dropIndex("inventory_location_code_idx")
    .on("inventory_location")
    .execute();
  await db.schema.dropTable("inventory_location").execute();
}