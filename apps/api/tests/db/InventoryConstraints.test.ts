// apps/api/tests/db/InventoryConstraints.test.ts
//
// REAL-POSTGRES INVENTORY / SOURCING CONSTRAINT TESTS — L9.
//
// These tests run against a freshly migrated `commerce_db_test` database and
// assert the DDL is the FINAL guard for the L9 inventory/sourcing invariants
// (migration 0016 + 0017 + 0018):
//
//   1. UNIQUE(variant_id, location_id) on inventory_level — exactly ONE
//      authoritative level per (variant, location) node.
//   2. CHECK(available_quantity >= 0) + CHECK(reserved_quantity >= 0) on
//      inventory_level — NEGATIVE STOCK IS IMPOSSIBLE no matter which code
//      path writes.
//   3. The atomic conditional reserve UPDATE (available - q, reserved + q
//      WHERE available >= q) returns ZERO rows once stock is exhausted — an
//      oversell is structurally impossible at the engine.
//   4. UNIQUE(reservation_key) on inventory_reservation — a retried/concurrent
//      duplicate reservation collides (SQLSTATE 23505) instead of
//      double-reserving.
//   5. CHECK(quantity > 0) on inventory_reservation — reservation lines are
//      always whole positive units.
//   6. CHECK(inventory_quantity >= 0) on product_variant — the legacy global
//      column also cannot go negative.
//
// AUTHORITATIVE PROOF FOR UNIQUE-COLLISION ROLLBACK: this suite is the ONLY
// place the losing transaction's decrement-rollback guarantee is grounded.
// `createIfAbsent` (PostgresInventoryReservationRepository) detects a
// concurrent winner via `ON CONFLICT (reservation_key) DO NOTHING RETURNING id`
// — a zero-row result means the winner already committed and the caller aborts
// the whole ITransactionManager unit, undoing its level decrement. That
// collision detection only WORKS because the UNIQUE constraint (point 4)
// exists. The final case in this suite drives a REAL transaction through the
// exact sequence (decrement -> collide on the deterministic key -> abort) and
// asserts the level is untouched afterwards. The in-memory concurrency suite
// models only the application-boundary semantics and never manufactures this
// rollback guarantee.
//
// Raw SQL drives the real engine directly — never the in-memory fakes — so a
// check_violation (SQLSTATE 23514) / unique_violation (SQLSTATE 23505) proves
// the DATABASE enforces the invariant.

import { sql } from "kysely";
import type { RawBuilder } from "kysely";
import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { getDbHarness } from "./dbHarness";

function q(raw: string): RawBuilder<unknown> {
  return sql.raw(raw);
}

async function isUniqueViolation(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "23505";
  }
}

async function isCheckViolation(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "23514";
  }
}

async function seedSourcingGraph(): Promise<{ loc: string }> {
  const h = getDbHarness();
  await q(
    "INSERT INTO product (id, title, handle) VALUES ('product-inv', 'Tee', 'tee-inv') ON CONFLICT (id) DO NOTHING",
  ).execute(h.db);
  await q(
    "INSERT INTO inventory_location (id, code, name) VALUES ('loc-inv', 'INV', 'Inventory Test Node') ON CONFLICT (id) DO NOTHING",
  ).execute(h.db);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    await q(
      `INSERT INTO product_variant (id, product_id, sku, inventory_quantity, allow_backorder) VALUES ('variant-inv${n}', 'product-inv', 'SKU-INV${n}', 10, false) ON CONFLICT (id) DO NOTHING`,
    ).execute(h.db);
  }
  return { loc: "loc-inv" };
}

describe("Real Postgres — ONE authoritative inventory_level per (variant, location)", () => {
  it("UNIQUE(variant_id, location_id) rejects a second level for the same pair", async () => {
    const h = getDbHarness();
    const { loc } = await seedSourcingGraph();
    const cols = "(id, variant_id, location_id, available_quantity, reserved_quantity, version)";
    await q(
      `INSERT INTO inventory_level ${cols} VALUES ('il-inv-1', 'variant-inv1', '${loc}', 10, 0, 0)`,
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        `INSERT INTO inventory_level ${cols} VALUES ('il-inv-1b', 'variant-inv1', '${loc}', 3, 0, 0)`,
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("CHECK available_quantity >= 0 rejects a negative available level", async () => {
    const h = getDbHarness();
    const { loc } = await seedSourcingGraph();
    const cols = "(id, variant_id, location_id, available_quantity, reserved_quantity, version)";
    const violated = await isCheckViolation(() =>
      q(
        `INSERT INTO inventory_level ${cols} VALUES ('il-neg', 'variant-inv2', '${loc}', -1, 0, 0)`,
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("CHECK reserved_quantity >= 0 rejects a negative reserved level", async () => {
    const h = getDbHarness();
    const { loc } = await seedSourcingGraph();
    const cols = "(id, variant_id, location_id, available_quantity, reserved_quantity, version)";
    const violated = await isCheckViolation(() =>
      q(
        `INSERT INTO inventory_level ${cols} VALUES ('il-resneg', 'variant-inv3', '${loc}', 10, -1, 0)`,
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });
});

describe("Real Postgres — the atomic conditional reserve can never oversell", () => {
  it("decrements exactly while available >= quantity, then returns ZERO rows (never negative)", async () => {
    const h = getDbHarness();
    const { loc } = await seedSourcingGraph();
    await q(
      `INSERT INTO inventory_level (id, variant_id, location_id, available_quantity, reserved_quantity, version)
       VALUES ('il-atomic', 'variant-inv4', '${loc}', 1, 0, 0)`,
    ).execute(h.db);

    // First claim consumes the final unit: 1 row updated.
    const first = await sql`
      UPDATE inventory_level
         SET available_quantity = available_quantity - 1,
             reserved_quantity   = reserved_quantity   + 1,
             version             = version             + 1
       WHERE variant_id = 'variant-inv4' AND location_id = ${loc}
         AND available_quantity >= 1
       RETURNING id
    `.execute(h.db);
    expect(first.rows).toHaveLength(1);

    // Second claim finds no availability: 0 rows updated — the engine refuses
    // the oversell, and the counters can never go negative.
    const second = await sql`
      UPDATE inventory_level
         SET available_quantity = available_quantity - 1,
             reserved_quantity   = reserved_quantity   + 1,
             version             = version             + 1
       WHERE variant_id = 'variant-inv4' AND location_id = ${loc}
         AND available_quantity >= 1
       RETURNING id
    `.execute(h.db);
    expect(second.rows).toHaveLength(0);

    const row = await sql<{ available: number; reserved: number }>`
      SELECT available_quantity AS available, reserved_quantity AS reserved
        FROM inventory_level WHERE id = 'il-atomic'
    `.execute(h.db);
    expect(Number(row.rows[0].available)).toBe(0);
    expect(Number(row.rows[0].reserved)).toBe(1);
  });
});

describe("Real Postgres — inventory_reservation ledger guards", () => {
  it("UNIQUE(reservation_key) rejects a duplicate reservation key", async () => {
    const h = getDbHarness();
    const { loc } = await seedSourcingGraph();
    const cols = "(id, reservation_key, location_id, variant_id, quantity, status, version)";
    await q(
      `INSERT INTO inventory_reservation ${cols} VALUES ('ir-1', 'reserve:order-1:variant-inv5:${loc}', '${loc}', 'variant-inv5', 2, 'reserved', 0)`,
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        `INSERT INTO inventory_reservation ${cols} VALUES ('ir-1b', 'reserve:order-1:variant-inv5:${loc}', '${loc}', 'variant-inv5', 2, 'reserved', 0)`,
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("CHECK quantity > 0 rejects zero and negative reservation quantities", async () => {
    const h = getDbHarness();
    const { loc } = await seedSourcingGraph();
    const cols = "(id, reservation_key, location_id, variant_id, quantity, status, version)";
    for (const quantity of [0, -1]) {
      const id = `ir-q${Math.abs(quantity) || 0}`;
      const violated = await isCheckViolation(() =>
        q(
          `INSERT INTO inventory_reservation ${cols} VALUES ('${id}', 'reserve:order-${id}:variant-inv6:${loc}', '${loc}', 'variant-inv6', ${quantity}, 'reserved', 0)`,
        ).execute(h.db),
      );
      expect(violated).toBe(true);
    }
  });

  it("a losing transaction that collides on UNIQUE(reservation_key) rolls back its level decrement", async () => {
    const h = getDbHarness();
    const { loc } = await seedSourcingGraph();
    const key = `reserve:order-collide:variant-inv8:${loc}`;
    const levelCols = "(id, variant_id, location_id, available_quantity, reserved_quantity, version)";
    await q(
      `INSERT INTO inventory_level ${levelCols} VALUES ('il-collide', 'variant-inv8', '${loc}', 5, 0, 0)`,
    ).execute(h.db);
    // The winner's committed row owns the deterministic key.
    const resCols = "(id, reservation_key, location_id, variant_id, quantity, status, version)";
    await q(
      `INSERT INTO inventory_reservation ${resCols} VALUES ('ir-winner', '${key}', '${loc}', 'variant-inv8', 2, 'reserved', 0)`,
    ).execute(h.db);

    // Drive a REAL transaction through the exact ReserveInventoryUseCase
    // sequence: the losing unit decrements the level first, then attempts the
    // keyed insert and collides. The 23505 abort rolls the whole unit back.
    const outcome: { collision: string | null } = { collision: null };
    try {
      await h.context.getDb().transaction().execute(async (trx) => {
        await sql`
          UPDATE inventory_level
             SET available_quantity = available_quantity - 2,
                 reserved_quantity   = reserved_quantity   + 2,
                 version             = version             + 1
           WHERE variant_id = 'variant-inv8' AND location_id = ${loc}
             AND available_quantity >= 2
        `.execute(trx);
        try {
          await q(
            `INSERT INTO inventory_reservation ${resCols} VALUES ('ir-loser', '${key}', '${loc}', 'variant-inv8', 2, 'reserved', 0)`,
          ).execute(trx);
        } catch (err: unknown) {
          outcome.collision = (err as { code?: string }).code ?? "unknown";
          throw err;
        }
      });
    } catch {
      // Expected: the unit aborted on the collision.
    }
    expect(outcome.collision).toBe("23505");

    // The losing unit's decrement was rolled back: 5/0, never 3/2.
    const level = await sql<{ available: number; reserved: number }>`
      SELECT available_quantity AS available, reserved_quantity AS reserved
        FROM inventory_level WHERE id = 'il-collide'
    `.execute(h.db);
    expect(Number(level.rows[0].available)).toBe(5);
    expect(Number(level.rows[0].reserved)).toBe(0);
  });
});

describe("Real Postgres — the legacy global stock column cannot go negative", () => {
  it("CHECK inventory_quantity >= 0 rejects a negative product_variant inventory", async () => {
    const h = getDbHarness();
    await seedSourcingGraph();
    const violated = await isCheckViolation(() =>
      q(
        "INSERT INTO product_variant (id, product_id, sku, inventory_quantity, allow_backorder) VALUES ('variant-inv7', 'product-inv', 'SKU-INV7', -1, false)",
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("the no-negative-stock CHECK constraints exist in the schema (the DB is the final guard)", async () => {
    const h = getDbHarness();
    const constraints = await sql<{ conname: string }>`
      SELECT conname FROM pg_constraint
       WHERE conname IN (
         'inventory_level_available_nonnegative_check',
         'inventory_level_reserved_nonnegative_check',
         'inventory_reservation_quantity_positive_check',
         'product_variant_inventory_nonnegative_check',
         'inventory_level_variant_location_unique'
       )
    `.execute(h.db);
    const names = constraints.rows.map((r) => r.conname).sort();
    expect(names).toEqual(
      [
        "inventory_level_available_nonnegative_check",
        "inventory_level_reserved_nonnegative_check",
        "inventory_level_variant_location_unique",
        "inventory_reservation_quantity_positive_check",
        "product_variant_inventory_nonnegative_check",
      ].sort(),
    );
  });
});