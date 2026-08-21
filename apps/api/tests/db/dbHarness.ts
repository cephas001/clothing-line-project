// apps/api/tests/db/dbHarness.ts
//
// REAL-POSTGRES VERIFICATION HARNESS (L6 items 26, 28, 29).
//
// The in-memory suites prove application invariants; this harness proves the
// DATABASE is the final guard. It provisions a dedicated throwaway database
// (`commerce_db_test`), runs the real migration history (0001..latest) on it,
// and exposes the real Kysely instance + TransactionContext + PostgresCartRepository
// so tests can assert:
//   - migrations apply cleanly and idempotently (item 29);
//   - the DDL constraints hold (payment/refund/fulfillment/cart) (item 28);
//   - the cart optimistic lock rejects stale writers (item 26).
//
// The harness is DB-GATED and standalone: `tests/db/run.ts` provisions the DB,
// imports the DB test files, runs them, and drops the DB. It is deliberately
// NOT part of `tests/run.ts` (the standard suite must stay DB-free and
// deterministic; these tests require a live Postgres on DATABASE_URL's host).
//
// Int8 (OID 20) is parsed to number exactly like the application connection
// (connection/kysely.ts) so monetary BIGINT columns round-trip as `number`.

import { Pool, types } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import type { Database } from "@api-infrastructure/database/schema/types";
import { TransactionContext } from "@api-infrastructure/database/transaction/TransactionContext";
import { PostgresCartRepository } from "@api-infrastructure/database/repositories/PostgresCartRepository";

// The maintenance database every Postgres cluster ships with.
const DEFAULT_MAINTENANCE_DB = "postgres";
const TEST_DB_NAME = "commerce_db_test";
const EXPECTED_MIGRATION_COUNT = 20;

types.setTypeParser(20, (value) => {
  return value === null ? null : Number(value);
});

export interface DbHarness {
  db: Kysely<Database>;
  context: TransactionContext;
  cartRepository: PostgresCartRepository;
  maintenanceUrl: string;
  testDbUrl: string;
}

let harness: DbHarness | null = null;

/**
 * The active DB harness. Throws if the DB suite was not bootstrapped first
 * (setupTestHarness must run before the DB test files execute).
 */
export function getDbHarness(): DbHarness {
  if (!harness) {
    throw new Error("DB harness not bootstrapped; run setupTestHarness() first.");
  }
  return harness;
}

/**
 * Derive the admin (maintenance) connection string from the base DATABASE_URL
 * by pointing at the `postgres` maintenance database with the same
 * credentials, so the suite works with any env configuration.
 */
function deriveMaintenanceUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error("DATABASE_URL is not set; the DB suite requires it.");
  }
  const url = new URL(base);
  url.pathname = `/${DEFAULT_MAINTENANCE_DB}`;
  return url.toString();
}

function deriveTestDbUrl(maintenanceUrl: string): string {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

async function recreateTestDatabase(maintenanceUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: maintenanceUrl, max: 1 });
  try {
    // Terminate any lingering connections then drop, so a prior failed run
    // never leaves a half-migrated database behind.
    await pool.query(
      `DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`,
    );
    await pool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await pool.end();
  }
}

/**
 * Bootstrap the DB harness: recreate the throwaway database and migrate it to
 * latest. Returns the harness; `getDbHarness()` returns it afterwards.
 */
export async function setupTestHarness(): Promise<DbHarness> {
  const maintenanceUrl = deriveMaintenanceUrl();
  const testDbUrl = deriveTestDbUrl(maintenanceUrl);
  await recreateTestDatabase(maintenanceUrl);

  const dialect = new PostgresDialect({
    pool: new Pool({ connectionString: testDbUrl, max: 5 }),
  });
  const db = new Kysely<Database>({ dialect });
  const context = new TransactionContext(db);
  const cartRepository = new PostgresCartRepository(context);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationFolder = path.resolve(
    __dirname,
    "../../src/infrastructure/database/migrations",
  );
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
      import: (modulePath) => import(pathToFileURL(modulePath).href),
    }),
  });
  const result = await migrator.migrateToLatest();
  if (result.error) {
    throw result.error;
  }
  if (!result.results || result.results.length !== EXPECTED_MIGRATION_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_MIGRATION_COUNT} migrations to apply, got ${
        result.results?.length ?? 0
      }.`,
    );
  }

  harness = { db, context, cartRepository, maintenanceUrl, testDbUrl };
  return harness;
}

/**
 * Re-run `migrateToLatest` to prove idempotency: a fully migrated database
 * applies ZERO further migrations without error.
 */
export async function rerunMigrations(h: DbHarness): Promise<{
  applied: number;
  error: unknown;
}> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationFolder = path.resolve(
    __dirname,
    "../../src/infrastructure/database/migrations",
  );
  const migrator = new Migrator({
    db: h.db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
      import: (modulePath) => import(pathToFileURL(modulePath).href),
    }),
  });
  const result = await migrator.migrateToLatest();
  return { applied: result.results?.length ?? 0, error: result.error };
}

/**
 * Verify the migration ledger lists all migrations as executed.
 */
export async function listMigrationLedger(
  h: DbHarness,
): Promise<{ name: string; executed: boolean }[]> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationFolder = path.resolve(
    __dirname,
    "../../src/infrastructure/database/migrations",
  );
  const migrator = new Migrator({
    db: h.db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
      import: (modulePath) => import(pathToFileURL(modulePath).href),
    }),
  });
  const migrations = await migrator.getMigrations();
  return migrations.map((m) => ({ name: m.name, executed: m.executedAt !== undefined }));
}

/**
 * Drop the throwaway database and destroy its connection.
 */
export async function teardownTestHarness(h: DbHarness): Promise<void> {
  await h.db.destroy();
  const pool = new Pool({ connectionString: h.maintenanceUrl, max: 1 });
  try {
    await pool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  } finally {
    await pool.end();
  }
}