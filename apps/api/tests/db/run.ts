// apps/api/tests/db/run.ts
//
// DB-GATED verification runner — L6 items 26, 28, 29.
//
// Bootstraps the real-Postgres harness (fresh `commerce_db_test` database,
// migrations 0001..latest), imports the DB test files (which register suites),
// runs them, and drops the database. Requires a live Postgres on the host
// named by DATABASE_URL.
//
// Usage: pnpm --filter @clothing-line-project/api db:test

import "dotenv/config";
import { setupTestHarness, teardownTestHarness } from "./dbHarness";
import { runAll } from "../harness/runner";

async function main(): Promise<void> {
  const harness = await setupTestHarness();
  try {
    // Register DB test suites (they resolve the harness lazily per case).
    await import("./ConstraintEnforcement.test");
    await import("./CartOptimisticLocking.test");
    await import("./MigrationIdempotency.test");
    await import("./PricingTaxConstraints.test");
    await import("./InventoryConstraints.test");

    const result = await runAll();
    if (result.failed > 0) {
      throw new Error(
        `DB verification failed (${result.failed} failing case(s)).`,
      );
    }
    process.stdout.write(
      `DB verification PASSED: ${result.passed} passed, ${result.failed} failed.\n`,
    );
  } finally {
    await teardownTestHarness(harness);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `DB verification FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});