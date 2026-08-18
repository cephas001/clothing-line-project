// apps/api/tests/db/PricingTaxConstraints.test.ts
//
// REAL-POSTGRES CANONICAL PRICING & TAX CONSTRAINT TESTS — L7-R.
//
// These tests run against a freshly migrated `commerce_db_test` database and
// assert the DDL is the final guard for the TWO canonical pricing/tax values
// established by L7-R:
//
//   1. REGIONAL PRICING — money_amount has UNIQUE(variant_id, region_id)
//      (money_amount_variant_region_unique from 0001): exactly ONE authoritative
//      price per (variant, region). A second price for the same pair is a
//      unique_violation (SQLSTATE 23505), while a different region is legal.
//      Migration 0013 adds CHECK amount_minor >= 0 (no negative price).
//
//   2. CANONICAL TAX — region.tax_rate is the single tax source, stored as
//      integer basis points, NOT NULL, with a CHECK range [0, 10000] added by
//      migration 0013 (0 = tax-exempt, 10000 = 100%). The retired tax_category
//      table is gone, so region.tax_rate is the ONLY tax configuration in the
//      schema.
//
// These tests drive the real Postgres engine directly (raw SQL), never the
// in-memory fakes, so a unique_violation / check_violation (SQLSTATE 23514)
// proves the database itself enforces the invariant.

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

describe("Real Postgres — canonical regional pricing constraint (money_amount)", () => {
  async function seedPricingGraph(): Promise<void> {
    const h = getDbHarness();
    await q(
      "INSERT INTO region (id, name, currency_code, tax_rate) VALUES ('region-p', 'Test', 'NGN', 750) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO product (id, title, handle) VALUES ('product-p', 'Tee', 'tee-p') ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    // Distinct variants so each case uses its OWN (variant, region) pair and the
    // cases are independent on the shared throwaway database.
    for (const n of [1, 2, 3, 4, 5]) {
      await q(
        `INSERT INTO product_variant (id, product_id, sku, inventory_quantity, allow_backorder) VALUES ('variant-p${n}', 'product-p', 'SKU-P${n}', 10, false) ON CONFLICT (id) DO NOTHING`,
      ).execute(h.db);
    }
  }

  it("UNIQUE(variant_id, region_id) rejects a second canonical price for the same (variant, region)", async () => {
    const h = getDbHarness();
    await seedPricingGraph();
    const cols = "(id, variant_id, region_id, amount_minor)";
    await q(
      `INSERT INTO money_amount ${cols} VALUES ('ma-p1', 'variant-p1', 'region-p', 25000)`,
    ).execute(h.db);
    const violated = await isUniqueViolation(() =>
      q(
        `INSERT INTO money_amount ${cols} VALUES ('ma-p2', 'variant-p1', 'region-p', 24000)`,
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("a different (variant, region) pair is a legal, distinct canonical price", async () => {
    const h = getDbHarness();
    await seedPricingGraph();
    const cols = "(id, variant_id, region_id, amount_minor)";
    await q(
      `INSERT INTO money_amount ${cols} VALUES ('ma-p10', 'variant-p2', 'region-p', 25000)`,
    ).execute(h.db);
    await q(
      `INSERT INTO money_amount ${cols} VALUES ('ma-p11', 'variant-p3', 'region-p', 22000)`,
    ).execute(h.db);
    const count = await sql<{ n: string }>`
      SELECT count(*)::int AS n FROM money_amount
      WHERE region_id = 'region-p' AND variant_id IN ('variant-p2', 'variant-p3')
    `.execute(h.db);
    expect(Number(count.rows[0].n)).toBe(2);
  });

  it("CHECK amount_minor >= 0 rejects a negative canonical price", async () => {
    const h = getDbHarness();
    await seedPricingGraph();
    const cols = "(id, variant_id, region_id, amount_minor)";
    const violated = await isCheckViolation(() =>
      q(
        `INSERT INTO money_amount ${cols} VALUES ('ma-neg', 'variant-p4', 'region-p', -1)`,
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("CHECK amount_minor >= 0 permits a zero price", async () => {
    const h = getDbHarness();
    await seedPricingGraph();
    const cols = "(id, variant_id, region_id, amount_minor)";
    await q(
      `INSERT INTO money_amount ${cols} VALUES ('ma-zero', 'variant-p5', 'region-p', 0)`,
    ).execute(h.db);
    const row = await sql<{ amount_minor: number }>`
      SELECT amount_minor FROM money_amount WHERE id = 'ma-zero'
    `.execute(h.db);
    expect(Number(row.rows[0].amount_minor)).toBe(0);
  });
});

describe("Real Postgres — canonical tax source (region.tax_rate)", () => {
  it("region.tax_rate is NOT NULL integer (single canonical tax source)", async () => {
    const h = getDbHarness();
    const columns = await sql<{ column_name: string; is_nullable: string; data_type: string }>`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
      WHERE table_name = 'region' AND column_name = 'tax_rate'
    `.execute(h.db);
    expect(columns.rows).toHaveLength(1);
    expect(columns.rows[0].is_nullable).toBe("NO");
    expect(columns.rows[0].data_type).toBe("integer");
  });

  it("CHECK range [0, 10000] rejects a negative tax rate", async () => {
    const h = getDbHarness();
    const violated = await isCheckViolation(() =>
      q(
        "INSERT INTO region (id, name, currency_code, tax_rate) VALUES ('region-badneg', 'Bad', 'NGN', -1)",
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("CHECK range [0, 10000] rejects a tax rate above 100% (10000 bps)", async () => {
    const h = getDbHarness();
    const violated = await isCheckViolation(() =>
      q(
        "INSERT INTO region (id, name, currency_code, tax_rate) VALUES ('region-badhi', 'Bad', 'NGN', 10001)",
      ).execute(h.db),
    );
    expect(violated).toBe(true);
  });

  it("CHECK range [0, 10000] accepts the boundary rates 0 and 10000", async () => {
    const h = getDbHarness();
    await q(
      "INSERT INTO region (id, name, currency_code, tax_rate) VALUES ('region-zero', 'Zero', 'NGN', 0) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    await q(
      "INSERT INTO region (id, name, currency_code, tax_rate) VALUES ('region-max', 'Max', 'NGN', 10000) ON CONFLICT (id) DO NOTHING",
    ).execute(h.db);
    const zero = await sql<{ tax_rate: number }>`
      SELECT tax_rate FROM region WHERE id = 'region-zero'
    `.execute(h.db);
    const max = await sql<{ tax_rate: number }>`
      SELECT tax_rate FROM region WHERE id = 'region-max'
    `.execute(h.db);
    expect(Number(zero.rows[0].tax_rate)).toBe(0);
    expect(Number(max.rows[0].tax_rate)).toBe(10000);
  });
});
