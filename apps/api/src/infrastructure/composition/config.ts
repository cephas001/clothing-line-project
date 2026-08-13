// apps/api/src/infrastructure/composition/config.ts

// Centralized application configuration boundary for the composition root.
//
// Only the composition root reads these values and passes them into concrete
// infrastructure constructors. Modules that already own a configuration value
// keep owning it, so nothing is read twice:
//   - DATABASE_URL      -> owned by infrastructure/database/connection/kysely.ts
//                          (the Kysely singleton is reused, never rebuilt).
//   - OTEL_*            -> owned by infrastructure/observability/config.ts.
//
// This module owns the values the composition root must inject at construction:
// HTTP port, Redis URL (one env value, two dedicated connection lifecycles: the
// session-revocation ioredis client and the BullMQ connection config), the JWT
// signing secret/lifetime, the bcrypt cost factor, and the log level.
//
// Fail-fast policy: JWT_SECRET has NO default — it is a production secret and
// the token service refuses to operate without it. Development-friendly
// defaults exist only for values that are safe to run without (PORT, REDIS_URL,
// JWT_EXPIRES_IN, BCRYPT_SALT_ROUNDS, LOG_LEVEL) and are documented as such.
//
// Paystack: PAYSTACK_SECRET_KEY is OPTIONAL at the config boundary because the
// Paystack adapter itself fails at construction without it, and the composition
// root only constructs the adapter when a secret is present. When absent, the
// payment use cases are reported as unwired (never faked), matching the
// external-service composition policy. The API runtime is the only consumer of
// these values; the worker runtime never reads them.

import type { Level } from "pino";

export interface AppConfig {
  /** HTTP port the Express server listens on. Default: 5000. */
  port: number;
  /**
   * Redis connection URL, shared by the session-revocation ioredis client and
   * the BullMQ connection config. Development-only default: redis://localhost:6379.
   */
  redisUrl: string;
  /** HMAC signing secret. REQUIRED — never defaulted. */
  jwtSecret: string;
  /** Default lifetime for auth tokens. Default: "1h". */
  jwtExpiresIn: string | number;
  /** bcrypt cost factor. Default: 12 (OWASP baseline). */
  bcryptSaltRounds: number;
  /** Minimum Pino level to emit. Default: "info". */
  logLevel: Level;
  /**
   * Paystack secret key. OPTIONAL here — the Paystack adapter requires it and
   * fails at construction without it; the composition root only builds the
   * adapter when it is present. Absent => payment use cases reported unwired.
   */
  paystackSecretKey?: string;
  /**
   * Paystack webhook signature secret. OPTIONAL here, like PAYSTACK_SECRET_KEY —
   * the webhook router is only mounted when it is present. This is a DISTINCT
   * secret from PAYSTACK_SECRET_KEY: it is the dedicated `webhook_secret`
   * Paystack uses to sign webhook bodies (HMAC-SHA512 over the raw request
   * bytes, delivered in the `x-paystack-signature` header). It MUST never be
   * derived from or shared with the API secret key. Absent => the webhook
   * endpoint is not mounted (requests receive a 404), never a fallback.
   */
  paystackWebhookSecret?: string;
  /** Paystack API base URL. Default: https://api.paystack.co (HTTPS enforced). */
  paystackBaseUrl: string;
  /** Per-request Paystack timeout in milliseconds. Default: 10000. */
  paystackTimeoutMs: number;
}

const DEFAULT_PORT = 5000;
const DEFAULT_REDIS_URL = "redis://localhost:6379"; // development-only default
const DEFAULT_JWT_EXPIRES_IN = "1h";
const DEFAULT_BCRYPT_SALT_ROUNDS = 12;
const DEFAULT_LOG_LEVEL: Level = "info";
const DEFAULT_PAYSTACK_BASE_URL = "https://api.paystack.co";
const DEFAULT_PAYSTACK_TIMEOUT_MS = 10_000;

const PINO_LEVELS: readonly Level[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

export function loadAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const port = parsePort(env.PORT);
  const jwtSecret = (env.JWT_SECRET ?? "").trim();
  if (!jwtSecret) {
    throw new Error(
      "JWT_SECRET is not set. Add it to your environment / .env (see apps/api/.env.example).",
    );
  }
  return {
    port,
    redisUrl: (env.REDIS_URL ?? "").trim() || DEFAULT_REDIS_URL,
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? DEFAULT_JWT_EXPIRES_IN,
    bcryptSaltRounds: parseSaltRounds(env.BCRYPT_SALT_ROUNDS),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    paystackSecretKey: (env.PAYSTACK_SECRET_KEY ?? "").trim() || undefined,
    paystackWebhookSecret:
      (env.PAYSTACK_WEBHOOK_SECRET ?? "").trim() || undefined,
    paystackBaseUrl:
      (env.PAYSTACK_BASE_URL ?? "").trim() || DEFAULT_PAYSTACK_BASE_URL,
    paystackTimeoutMs: parsePaystackTimeout(env.PAYSTACK_TIMEOUT_MS),
  };
}

/** Absent PAYSTACK_TIMEOUT_MS uses the default; an explicit invalid value fails fast. */
function parsePaystackTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PAYSTACK_TIMEOUT_MS;
  }
  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(
      `PAYSTACK_TIMEOUT_MS must be a positive integer of milliseconds; received "${raw}".`,
    );
  }
  return timeout;
}

/** Absent PORT uses the development default; an explicit invalid value fails fast. */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535; received "${raw}".`);
  }
  return port;
}

/** Absent BCRYPT_SALT_ROUNDS uses 12; range validation is left to the service. */
function parseSaltRounds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_BCRYPT_SALT_ROUNDS;
  }
  return Number(raw);
}

/** Absent or unknown LOG_LEVEL falls back to "info". */
function parseLogLevel(raw: string | undefined): Level {
  const candidate = (raw ?? "").toLowerCase() as Level;
  return (PINO_LEVELS as readonly string[]).includes(candidate)
    ? candidate
    : DEFAULT_LOG_LEVEL;
}
