// apps/api/tests/db/MigrationIdempotency.test.ts
//
// REAL-POSTGRES MIGRATION APPLICABILITY + IDEMPOTENCY TEST — L6 item 29.
//
// The harness migrates a FRESH database to latest before any DB test runs
// (setupTestHarness). This suite re-runs `migrateToLatest()` on the already
// migrated database and asserts:
//   - the ledger records every migration as executed (clean, ordered apply);
//   - re-running the same migrations applies ZERO additional steps (idempotent)
//     and does not error — the critical property for at-least-once deploy runs
//     and for worker/API boots that share the migration history.

import { sql } from "kysely";
import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { getDbHarness, rerunMigrations, listMigrationLedger } from "./dbHarness";

describe("Real Postgres — migration applicability and idempotency (item 29)", () => {
  it("fresh database migrated to latest in setup — ledger lists every migration executed", async () => {
    const h = getDbHarness();
    const ledger = await listMigrationLedger(h);
    expect(ledger.length).toBe(18);
    for (const migration of ledger) {
      expect(migration.executed).toBe(true);
    }
  });

  it("re-running migrateToLatest applies ZERO migrations and does not error", async () => {
    const h = getDbHarness();
    const result = await rerunMigrations(h);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(0);
  });

  it("core schema objects referenced by the domain exist after migration", async () => {
    const h = getDbHarness();
    const listed = await sql<{ tablename: string }>`
      SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'
    `.execute(h.db);
    const names = listed.rows.map((r) => r.tablename);
    for (const expected of [
      "cart",
      "cart_line_item",
      "customer",
      "order",
      "payment",
      "refund",
      "fulfillment",
      "audit_log",
      "region",
      "money_amount",
      "notification_outbox",
      "inventory_location",
      "inventory_level",
      "inventory_reservation",
    ]) {
      expect(names.includes(expected)).toBe(true);
    }
  });

  it("the retired tax_category table is absent (canonical tax source is region.tax_rate)", async () => {
    const h = getDbHarness();
    const listed = await sql<{ tablename: string }>`
      SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'
    `.execute(h.db);
    const names = listed.rows.map((r) => r.tablename);
    expect(names.includes("tax_category")).toBe(false);
  });
});