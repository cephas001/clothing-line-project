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

/** Verified sender/origin address required by Shipbubble's rates API. */
export interface ShipbubbleSenderAddressConfig {
  name: string;
  email: string;
  phone: string;
  address: string;
}

/** Package dimensions in centimetres. */
export interface ShipbubblePackageDimensionsConfig {
  length: number;
  width: number;
  height: number;
}

export interface AppConfig {
  /** HTTP port the Express server listens on. Default: 5000. */
  port: number;
  /**
   * Browser origin permitted by the CORS policy (FRONTEND_URL). Absent =>
   * any origin is allowed (development posture; a warning is logged at boot).
   */
  frontendUrl?: string;
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
   * Whether the Pino transport renders human-readable development output
   * (pino-pretty) instead of structured JSON. Resolved centrally by
   * `resolveLogPretty`: LOG_PRETTY=true/false win explicitly, otherwise pretty
   * only in non-production interactive terminals. Redaction is applied by Pino
   * BEFORE the transport, so pretty output never exposes redacted fields.
   */
  logPretty: boolean;
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
  /**
   * Shipbubble API key. OPTIONAL here — the Shipbubble adapter requires it (plus
   * the sender address and package category) and fails at construction without
   * them; the composition root only builds the adapter when the key is present.
   * Absent => logistics use cases reported unwired.
   */
  shipbubbleApiKey?: string;
  /**
   * Shipbubble webhook signature secret. OPTIONAL here, like
   * SHIPBUBBLE_API_KEY — the logistics webhook router is only mounted when it
   * is present. This is a DISTINCT secret from SHIPBUBBLE_API_KEY: it is the
   * dedicated secret Shipbubble uses to sign webhook bodies (HMAC-SHA512 over
   * the raw request bytes, delivered in the `x-shipbubble-signature` header).
   * It MUST never be derived from or shared with the API key. There is NO
   * default — a production webhook signing secret is never defaulted. Absent =>
   * the webhook endpoint is not mounted (requests receive a 404), never a
   * fallback.
   */
  shipbubbleWebhookSecret?: string;
  /**
   * Courier-tracking webhook signature secret. OPTIONAL here, like
   * SHIPBUBBLE_WEBHOOK_SECRET — the courier-tracking webhook router is only
   * mounted when it is present. This is the dedicated secret used to sign
   * courier-tracking webhook bodies (HMAC-SHA512 over the raw request bytes,
   * delivered in the `x-courier-signature` header). It MUST never be derived
   * from or shared with any API key. There is NO default — a production
   * webhook signing secret is never defaulted. Absent => the webhook endpoint
   * is not mounted (requests receive a 404), never a fallback.
   */
  courierTrackingWebhookSecret?: string;
  /** Shipbubble API base URL. Default: https://api.shipbubble.com (HTTPS enforced). */
  shipbubbleBaseUrl: string;
  /** Per-request Shipbubble timeout in milliseconds. Default: 10000. */
  shipbubbleTimeoutMs: number;
  /**
   * Verified sender/origin address required by Shipbubble's rates API
   * (parsed from SHIPBUBBLE_SENDER_ADDRESS JSON). Absent => the adapter is not
   * constructed even when the API key is present.
   */
  shipbubbleSenderAddress?: ShipbubbleSenderAddressConfig;
  /**
   * Shipbubble package category id required by every rates request
   * (parsed from SHIPBUBBLE_PACKAGE_CATEGORY_ID).
   */
  shipbubblePackageCategoryId?: number;
  /** Fallback per-item weight in kilograms (cart metadata.weightKg wins). Default: 1. */
  shipbubbleDefaultItemWeightKg: number;
  /**
   * Fallback package dimensions in centimetres (parsed from
   * SHIPBUBBLE_DEFAULT_PACKAGE_DIMENSIONS). Default: { length: 10, width: 10,
   * height: 10 }.
   */
  shipbubbleDefaultPackageDimensions: ShipbubblePackageDimensionsConfig;
  /**
   * Notification provider name. Only "resend" is supported today; an unknown
   * explicit value fails fast. Default: "resend".
   */
  notificationProvider: string;
  /**
   * Notification provider API key. OPTIONAL here — the Resend adapter requires
   * it and fails at construction without it; the composition root only builds
   * the adapter when it is present. Absent => notification intents reported
   * unwired. NEVER defaulted, NEVER logged.
   */
  notificationApiKey?: string;
  /**
   * Notification provider API base URL. Default: https://api.resend.com
   * (HTTPS enforced by the adapter).
   */
  notificationBaseUrl: string;
  /** Per-request notification timeout in milliseconds. Default: 10000. */
  notificationTimeoutMs: number;
  /**
   * Authoritative sender address. REQUIRED when NOTIFICATION_API_KEY is
   * present — the composition root fails fast if the key is set but the
   * from-email is missing (mirrors the Shipbubble sender-address policy).
   */
  notificationFromEmail?: string;
  /** Optional sender display name (NOTIFICATION_FROM_NAME). */
  notificationFromName?: string | null;
  /**
   * Base URL used to build the single-use password-reset link in the
   * password-reset email (e.g. "https://shop.example.com/reset-password?token=").
   * Absent => the reset email renders the raw token instead of a link.
   */
  notificationPasswordResetUrl?: string | null;
  /**
   * TTL (seconds) for cached product catalog reads (the
   * CachedProductReadRepository decorator). Default: 60. A short TTL bounds how
   * stale a cached listing/detail can be; Postgres stays the source of truth.
   */
  productCacheTtlSeconds: number;
}

const DEFAULT_PORT = 5000;
const DEFAULT_REDIS_URL = "redis://localhost:6379"; // development-only default
const DEFAULT_JWT_EXPIRES_IN = "1h";
const DEFAULT_BCRYPT_SALT_ROUNDS = 12;
const DEFAULT_LOG_LEVEL: Level = "info";
const DEFAULT_PAYSTACK_BASE_URL = "https://api.paystack.co";
const DEFAULT_PAYSTACK_TIMEOUT_MS = 10_000;
const DEFAULT_SHIPBUBBLE_BASE_URL = "https://api.shipbubble.com";
const DEFAULT_SHIPBUBBLE_TIMEOUT_MS = 10_000;
const DEFAULT_SHIPBUBBLE_ITEM_WEIGHT_KG = 1;
const DEFAULT_SHIPBUBBLE_DIMENSIONS: ShipbubblePackageDimensionsConfig = {
  length: 10,
  width: 10,
  height: 10,
};
const DEFAULT_NOTIFICATION_PROVIDER = "resend";
const DEFAULT_NOTIFICATION_BASE_URL = "https://api.resend.com";
const DEFAULT_NOTIFICATION_TIMEOUT_MS = 10_000;
const DEFAULT_PRODUCT_CACHE_TTL_SECONDS = 60;
const SUPPORTED_NOTIFICATION_PROVIDERS: readonly string[] = ["resend"];

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
    frontendUrl: (env.FRONTEND_URL ?? "").trim() || undefined,
    redisUrl: (env.REDIS_URL ?? "").trim() || DEFAULT_REDIS_URL,
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? DEFAULT_JWT_EXPIRES_IN,
    bcryptSaltRounds: parseSaltRounds(env.BCRYPT_SALT_ROUNDS),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    logPretty: resolveLogPretty(env),
    paystackSecretKey: (env.PAYSTACK_SECRET_KEY ?? "").trim() || undefined,
    paystackWebhookSecret:
      (env.PAYSTACK_WEBHOOK_SECRET ?? "").trim() || undefined,
    paystackBaseUrl:
      (env.PAYSTACK_BASE_URL ?? "").trim() || DEFAULT_PAYSTACK_BASE_URL,
    paystackTimeoutMs: parsePaystackTimeout(env.PAYSTACK_TIMEOUT_MS),
    shipbubbleApiKey: (env.SHIPBUBBLE_API_KEY ?? "").trim() || undefined,
    shipbubbleWebhookSecret:
      (env.SHIPBUBBLE_WEBHOOK_SECRET ?? "").trim() || undefined,
    courierTrackingWebhookSecret:
      (env.COURIER_TRACKING_WEBHOOK_SECRET ?? "").trim() || undefined,
    shipbubbleBaseUrl:
      (env.SHIPBUBBLE_BASE_URL ?? "").trim() || DEFAULT_SHIPBUBBLE_BASE_URL,
    shipbubbleTimeoutMs: parseShipbubbleTimeout(env.SHIPBUBBLE_TIMEOUT_MS),
    shipbubbleSenderAddress: parseShipbubbleSenderAddress(
      env.SHIPBUBBLE_SENDER_ADDRESS,
    ),
    shipbubblePackageCategoryId: parseShipbubbleCategoryId(
      env.SHIPBUBBLE_PACKAGE_CATEGORY_ID,
    ),
    shipbubbleDefaultItemWeightKg: parseShipbubbleItemWeight(
      env.SHIPBUBBLE_DEFAULT_ITEM_WEIGHT_KG,
    ),
    shipbubbleDefaultPackageDimensions: parseShipbubbleDimensions(
      env.SHIPBUBBLE_DEFAULT_PACKAGE_DIMENSIONS,
    ),
    notificationProvider: parseNotificationProvider(
      env.NOTIFICATION_PROVIDER,
    ),
    notificationApiKey: (env.NOTIFICATION_API_KEY ?? "").trim() || undefined,
    notificationBaseUrl:
      (env.NOTIFICATION_BASE_URL ?? "").trim() ||
      DEFAULT_NOTIFICATION_BASE_URL,
    notificationTimeoutMs: parseNotificationTimeout(
      env.NOTIFICATION_TIMEOUT_MS,
    ),
    notificationFromEmail:
      (env.NOTIFICATION_FROM_EMAIL ?? "").trim() || undefined,
    notificationFromName: optionalTrimmedString(env.NOTIFICATION_FROM_NAME),
    notificationPasswordResetUrl: optionalTrimmedString(
      env.NOTIFICATION_PASSWORD_RESET_URL,
    ),
    productCacheTtlSeconds: parseProductCacheTtlSeconds(
      env.PRODUCT_CACHE_TTL_SECONDS,
    ),
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

/** Absent SHIPBUBBLE_TIMEOUT_MS uses the default; an explicit invalid value fails fast. */
function parseShipbubbleTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SHIPBUBBLE_TIMEOUT_MS;
  }
  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(
      `SHIPBUBBLE_TIMEOUT_MS must be a positive integer of milliseconds; received "${raw}".`,
    );
  }
  return timeout;
}

/**
 * Parse the SHIPBUBBLE_SENDER_ADDRESS JSON ({"name","email","phone","address"}).
 * Absent -> undefined (the adapter is not constructed without it). An explicit
 * malformed value fails fast so configuration errors surface at startup.
 */
function parseShipbubbleSenderAddress(
  raw: string | undefined,
): ShipbubbleSenderAddressConfig | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "SHIPBUBBLE_SENDER_ADDRESS must be a JSON object: {\"name\":\"...\",\"email\":\"...\",\"phone\":\"...\",\"address\":\"...\"}.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SHIPBUBBLE_SENDER_ADDRESS must be a JSON object.");
  }
  const o = parsed as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const email = typeof o.email === "string" ? o.email.trim() : "";
  const phone = typeof o.phone === "string" ? o.phone.trim() : "";
  const address = typeof o.address === "string" ? o.address.trim() : "";
  if (!name || !email || !phone || !address) {
    throw new Error(
      "SHIPBUBBLE_SENDER_ADDRESS must include non-empty name, email, phone and address.",
    );
  }
  return { name, email, phone, address };
}

/** Absent SHIPBUBBLE_PACKAGE_CATEGORY_ID uses undefined; an explicit invalid value fails fast. */
function parseShipbubbleCategoryId(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const categoryId = Number(raw);
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    throw new Error(
      `SHIPBUBBLE_PACKAGE_CATEGORY_ID must be a positive integer; received "${raw}".`,
    );
  }
  return categoryId;
}

/** Absent SHIPBUBBLE_DEFAULT_ITEM_WEIGHT_KG uses 1; an explicit invalid value fails fast. */
function parseShipbubbleItemWeight(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SHIPBUBBLE_ITEM_WEIGHT_KG;
  }
  const weight = Number(raw);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(
      `SHIPBUBBLE_DEFAULT_ITEM_WEIGHT_KG must be a positive number; received "${raw}".`,
    );
  }
  return weight;
}

/**
 * Parse the SHIPBUBBLE_DEFAULT_PACKAGE_DIMENSIONS JSON ({"length","width",
 * "height"} in centimetres). Absent -> the documented default.
 */
function parseShipbubbleDimensions(
  raw: string | undefined,
): ShipbubblePackageDimensionsConfig {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SHIPBUBBLE_DIMENSIONS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'SHIPBUBBLE_DEFAULT_PACKAGE_DIMENSIONS must be a JSON object: {"length":10,"width":10,"height":10}.',
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SHIPBUBBLE_DEFAULT_PACKAGE_DIMENSIONS must be a JSON object.");
  }
  const o = parsed as Record<string, unknown>;
  const length = Number(o.length);
  const width = Number(o.width);
  const height = Number(o.height);
  if (
    !Number.isFinite(length) || length <= 0 ||
    !Number.isFinite(width) || width <= 0 ||
    !Number.isFinite(height) || height <= 0
  ) {
    throw new Error(
      "SHIPBUBBLE_DEFAULT_PACKAGE_DIMENSIONS length/width/height must be positive numbers.",
    );
  }
  return { length, width, height };
}

/** Absent NOTIFICATION_TIMEOUT_MS uses the default; an explicit invalid value fails fast. */
function parseNotificationTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_NOTIFICATION_TIMEOUT_MS;
  }
  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(
      `NOTIFICATION_TIMEOUT_MS must be a positive integer of milliseconds; received "${raw}".`,
    );
  }
  return timeout;
}

/** Absent NOTIFICATION_PROVIDER uses "resend"; an unknown explicit value fails fast. */
function parseNotificationProvider(raw: string | undefined): string {
  const provider = (raw ?? "").trim().toLowerCase() || DEFAULT_NOTIFICATION_PROVIDER;
  if (!(SUPPORTED_NOTIFICATION_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `NOTIFICATION_PROVIDER must be one of: ${SUPPORTED_NOTIFICATION_PROVIDERS.join(", ")}; received "${raw}".`,
    );
  }
  return provider;
}

/** Absent or empty value -> undefined (allows clearing a nullable field). */
function optionalTrimmedString(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Absent PRODUCT_CACHE_TTL_SECONDS uses 60s; an explicit invalid value fails fast. */
function parseProductCacheTtlSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PRODUCT_CACHE_TTL_SECONDS;
  }
  const ttl = Number(raw);
  if (!Number.isInteger(ttl) || ttl < 1) {
    throw new Error(
      `PRODUCT_CACHE_TTL_SECONDS must be a positive integer of seconds; received "${raw}".`,
    );
  }
  return ttl;
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

/**
 * Resolve whether the Pino transport should render human-readable output.
 *
 * Local development is the ONLY environment that should ever be pretty:
 *   - `LOG_PRETTY=true` forces pretty output. The local-development .env files
 *     provisioned by scripts/prepare-env.mjs set this so the root `pnpm dev`
 *     command gets readable logs even though turbo pipes the children's stdout
 *     (never a TTY). `LOG_PRETTY=false` forces structured JSON everywhere and
 *     overrides the .env value (dotenv never overrides an existing env var).
 *   - Otherwise pretty is used only when stdout is an interactive TTY AND the
 *     process is not production (NODE_ENV !== "production").
 *
 * Production deployments therefore keep machine-readable JSON unless an
 * operator explicitly opts in. This is the single, centralized environment
 * distinction for logging — nothing else in the codebase branches on it.
 * The `isTTY` parameter exists so tests can exercise the decision without a
 * terminal.
 */
export function resolveLogPretty(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): boolean {
  const raw = (env.LOG_PRETTY ?? "").trim().toLowerCase();
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return env.NODE_ENV !== "production" && isTTY;
}
