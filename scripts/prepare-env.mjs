// scripts/prepare-env.mjs
//
// Idempotent local-development environment provisioning for the monorepo.
// Run automatically by `pnpm dev` (before turbo) or manually via `pnpm setup`.
//
// Ensures the gitignored env files exist with the core values the runtimes
// need to boot against docker-compose.yml:
//   - apps/api/.env          DATABASE_URL + JWT_SECRET + LOG_PRETTY
//   - apps/worker/.env       DATABASE_URL + JWT_SECRET + LOG_PRETTY (same
//                            secret as the API)
//   - apps/storefront/.env.local  NEXT_PUBLIC_API_URL
//
// Rules:
//   - Never overwrites a value that is already present.
//   - DATABASE_URL is DERIVED from docker-compose.yml (the single source of
//     truth for the local Postgres credential) — never hard-coded here.
//   - Generates ONE random per-machine JWT_SECRET when none exists and reuses
//     it across the API and the worker so both runtimes share a signing secret.
//   - LOG_PRETTY=true is provisioned as the local-development default so the
//     Pino runtimes render human-readable logs. Because dotenv never overrides
//     an existing env var, a developer can still force JSON with
//     LOG_PRETTY=false in their shell. Production deployments never see these
//     gitignored files.
//   - Writes only gitignored files. No dependencies beyond Node built-ins.
//   - The fail-fast configuration invariant is preserved: JWT_SECRET has no
//     hard-coded default anywhere; it is provisioned per machine instead.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const COMPOSE_FILE = path.join(repoRoot, "docker-compose.yml");
const STOREFRONT_API_URL = "http://localhost:5000";
const PRISM_MOCK_URL = "http://localhost:4010";

/**
 * Derive the local Postgres connection string from docker-compose.yml — the
 * single source of truth for the local credential — rather than duplicating
 * the user/password here. A missing or incomplete compose file fails fast
 * instead of silently provisioning a URL that cannot connect.
 */
function buildDatabaseUrl() {
  if (!existsSync(COMPOSE_FILE)) {
    throw new Error(
      `docker-compose.yml not found at ${COMPOSE_FILE}; cannot derive DATABASE_URL.`,
    );
  }
  const compose = readFileSync(COMPOSE_FILE, "utf8");
  const value = (key) => {
    const m = new RegExp(`^\\s*${key}:\\s*(\\S+)`, "m").exec(compose);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  const user = value("POSTGRES_USER");
  const password = value("POSTGRES_PASSWORD");
  const db = value("POSTGRES_DB");
  if (!user || !password || !db) {
    throw new Error(
      "docker-compose.yml is missing POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB; cannot derive DATABASE_URL.",
    );
  }
  // Published host port for the postgres container port (5432), e.g. "5433:5432".
  const port = /-\s*["']?(\d+):5432["']?/.exec(compose);
  const hostPort = port ? port[1] : "5432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${hostPort}/${encodeURIComponent(db)}`;
}

function readLines(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").split("\n");
}

function readValue(filePath, key) {
  const lines = readLines(filePath);
  if (!lines) {
    return undefined;
  }
  for (const line of lines) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`).exec(line);
    if (m) {
      return m[1].trim();
    }
  }
  return undefined;
}

/**
 * Create (with a header comment) or merge the given key/value pairs into an
 * env file. Existing values are never overwritten.
 */
function ensureEnv(filePath, entries, headerLines = []) {
  const rel = path.relative(repoRoot, filePath);
  const existed = existsSync(filePath);
  const lines = existed ? readLines(filePath) : [];
  const present = new Set();
  for (const line of lines) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m) {
      present.add(m[1]);
    }
  }
  const missing = Object.entries(entries).filter(([key]) => !present.has(key));
  if (missing.length === 0) {
    console.log(`  ${existed ? "ok" : "skip"}  ${rel} (nothing to add)`);
    return;
  }
  const finalLines = existed ? [...lines] : [...headerLines];
  for (const [key, value] of missing) {
    finalLines.push(`${key}=${value}`);
  }
  if (!existed) {
    finalLines.push("");
  }
  writeFileSync(filePath, finalLines.join("\n"), "utf8");
  const added = missing.map(([key]) => key).join(", ");
  console.log(`  ${existed ? "upd" : "new"}  ${rel} (+${added})`);
}

/** Correct a stale Prism mock URL in NEXT_PUBLIC_API_URL (legacy default). */
function normalizeStorefrontApiUrl(filePath) {
  const rel = path.relative(repoRoot, filePath);
  const lines = readLines(filePath);
  if (!lines) {
    return;
  }
  let changed = false;
  const normalized = lines.map((line) => {
    if (
      !changed &&
      new RegExp(
        `^\\s*NEXT_PUBLIC_API_URL\\s*=\\s*${escapeRegExp(PRISM_MOCK_URL)}\\s*$`,
      ).test(line)
    ) {
      changed = true;
      return `NEXT_PUBLIC_API_URL=${STOREFRONT_API_URL}`;
    }
    return line;
  });
  if (!changed) {
    return;
  }
  writeFileSync(filePath, normalized.join("\n"), "utf8");
  console.log(
    `  upd  ${rel} (NEXT_PUBLIC_API_URL ${PRISM_MOCK_URL} -> ${STOREFRONT_API_URL}, was the Prism mock URL)`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
  const apiEnv = path.join(repoRoot, "apps/api/.env");
  const workerEnv = path.join(repoRoot, "apps/worker/.env");
  const storefrontEnv = path.join(repoRoot, "apps/storefront/.env.local");

  const existingSecret = readValue(apiEnv, "JWT_SECRET");
  const jwtSecret = existingSecret ?? randomBytes(32).toString("hex");
  const databaseUrl = buildDatabaseUrl();
  const logPretty = "true";

  console.log("Provisioning local development environment (.env files):");
  ensureEnv(
    apiEnv,
    { DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret, LOG_PRETTY: logPretty },
    [
      "# Local development environment for @clothing-line-project/api.",
      "# Generated by scripts/prepare-env.mjs (run automatically by `pnpm dev`).",
      "# See apps/api/.env.example for the full option list.",
    ],
  );
  ensureEnv(
    workerEnv,
    {
      DATABASE_URL: databaseUrl,
      JWT_SECRET: jwtSecret,
      LOG_PRETTY: logPretty,
    },
    [
      "# Local development environment for @clothing-line-project/worker.",
      "# Generated by scripts/prepare-env.mjs (run automatically by `pnpm dev`).",
      "# See apps/worker/.env.example for the full option list.",
    ],
  );
  ensureEnv(storefrontEnv, { NEXT_PUBLIC_API_URL: STOREFRONT_API_URL }, [
    "# Local development environment for @clothing-line-project/storefront.",
    "# Generated by scripts/prepare-env.mjs.",
    "# See apps/storefront/.env.example for the full option list.",
  ]);
  normalizeStorefrontApiUrl(storefrontEnv);
  console.log(
    "Done. Secrets are per-machine and never committed (see .gitignore).",
  );
}

main();
