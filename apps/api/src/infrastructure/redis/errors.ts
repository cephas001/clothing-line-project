// apps/api/src/infrastructure/redis/errors.ts

// Shared error mapping for Redis-backed infrastructure services.
//
// Mirrors the Postgres repository convention (see
// infrastructure/database/repositories/errorMapping.ts): driver-level failures
// are normalized into RepositoryError with the RepositoryErrorCode vocabulary
// so the use-case layer can map them onto stable DomainError codes
// (e.g. CONNECTION -> EXTERNAL_SERVICE_UNAVAILABLE, TIMEOUT ->
// EXTERNAL_SERVICE_TIMEOUT).
//
// Security: these messages never contain tokens, signatures, or credentials.

import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { RepositoryError } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { StructuredMeta } from "@api/domain/shared/contracts";

/** Error subclass carrying the RepositoryError code contract for Redis failures. */
export class RedisRepositoryError extends Error implements RepositoryError {
  readonly code: RepositoryErrorCode;
  readonly meta?: StructuredMeta;
  /** The original driver error, preserved for diagnostics (never surfaced). */
  cause?: unknown;

  constructor(code: RepositoryErrorCode, message: string, meta?: StructuredMeta) {
    super(message);
    this.name = "RedisRepositoryError";
    this.code = code;
    this.meta = meta;
  }
}

/** OS-level error codes that indicate the Redis endpoint could not be reached. */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "EAI_AGAIN",
]);

function classifyRedisError(err: unknown): RepositoryErrorCode {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      if (CONNECTION_ERROR_CODES.has(code)) {
        return RepositoryErrorCode.CONNECTION;
      }
      if (code === "ETIMEDOUT") {
        return RepositoryErrorCode.TIMEOUT;
      }
    }
  }
  const message = err instanceof Error ? err.message : "";
  if (/timeout|timed out/i.test(message)) {
    return RepositoryErrorCode.TIMEOUT;
  }
  if (/connection is closed|stream.*(not open|closed)|connection.*(refused|reset|closed)|disconnected/i.test(message)) {
    return RepositoryErrorCode.CONNECTION;
  }
  return RepositoryErrorCode.UNKNOWN;
}

/**
 * Normalizes an unknown Redis/ioredis error into a RepositoryError. Errors that
 * are already RepositoryErrors are passed through unchanged. The raw error is
 * preserved as the cause so the underlying failure is not lost.
 */
export function toRedisRepositoryError(err: unknown): RepositoryError {
  if (err && typeof err === "object" && "code" in err) {
    const existing = (err as { code?: unknown }).code;
    if (
      typeof existing === "string" &&
      (Object.values(RepositoryErrorCode) as string[]).includes(existing)
    ) {
      return err as RepositoryError;
    }
  }

  const code = classifyRedisError(err);
  const message = err instanceof Error ? err.message : "Redis operation failed.";
  const error = new RedisRepositoryError(code, message);
  error.cause = err;
  return error;
}
