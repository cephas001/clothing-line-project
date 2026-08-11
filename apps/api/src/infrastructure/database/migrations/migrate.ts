// apps/api/src/infrastructure/database/migrations/migrate.ts
//
// CLI runner for the Kysely schema migrations.
//
// Usage:
//   pnpm --filter @clothing-line-project/api db:migrate           # migrate to latest (default)
//   pnpm --filter @clothing-line-project/api db:migrate:up        # one step up
//   pnpm --filter @clothing-line-project/api db:migrate:down      # one step down
//   pnpm --filter @clothing-line-project/api db:migrate -- --to <name>
//   pnpm --filter @clothing-line-project/api db:migrate -- --list
//
// Requires a running Postgres (see docker-compose.yml) and DATABASE_URL.
// See ../connection/kysely.ts for the connection configuration and defaults.

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { db } from "../connection/kysely";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationFolder = __dirname;

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({
    fs,
    path,
    migrationFolder,
    // On Windows the default ESM loader rejects bare `C:\...` paths; convert
    // them to `file://` URLs before dynamic import.
    import: (modulePath) => import(pathToFileURL(modulePath).href),
  }),
});

function printResults(results: { migrationName: string; status: string; direction: string }[]): void {
  for (const it of results) {
    if (it.status === "Success") {
      console.log(`migration "${it.migrationName}" (${it.direction}) was executed successfully`);
    } else if (it.status === "Error") {
      console.error(`failed to execute migration "${it.migrationName}"`);
    }
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const toIndex = args.indexOf("--to");
  const toName = toIndex !== -1 ? args[toIndex + 1] : undefined;
  const list = args.includes("--list");
  const up = args.includes("--up");
  const down = args.includes("--down");

  let result;
  if (list) {
    const migrations = await migrator.getMigrations();
    for (const m of migrations) {
      console.log(`${m.executedAt ? "[x]" : "[ ]"} ${m.name}`);
    }
    return;
  } else if (down) {
    result = await migrator.migrateDown();
  } else if (up) {
    result = await migrator.migrateUp();
  } else if (toName) {
    result = await migrator.migrateTo(toName);
  } else {
    result = await migrator.migrateToLatest();
  }

  const { error, results } = result;
  if (results) {
    printResults(results);
  }
  if (error) {
    console.error("failed to run migrations");
    console.error(error);
    process.exitCode = 1;
  }
}

run()
  .then(() => db.destroy())
  .catch(async (error) => {
    console.error(error);
    await db.destroy();
    process.exitCode = 1;
  });
