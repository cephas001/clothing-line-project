// apps/api/src/infrastructure/database/repositories/errorMapping.ts

// Shared error-mapping helpers for the Postgres repository implementations.
//
// Repositories surface failures as RepositoryError (from the domain shared
// contracts) so the use-case layer can map them onto stable DomainError codes.
// This module normalizes driver-level errors (PostgreSQL error codes) into the
// RepositoryErrorCode vocabulary used across the application, and rethrows
// domain errors untouched.

import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { RepositoryError } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { StructuredMeta } from "@api/domain/shared/contracts";

// Error subclass carrying the RepositoryError code contract so consumers can
// inspect `err.code` without instanceof checks against driver classes.
export class PostgresRepositoryError extends Error implements RepositoryError {
  readonly code: RepositoryErrorCode;
  readonly meta?: StructuredMeta;

  constructor(code: RepositoryErrorCode, message: string, meta?: StructuredMeta) {
    super(message);
    this.name = "PostgresRepositoryError";
    this.code = code;
    this.meta = meta;
  }
}

// PostgreSQL SQLSTATE -> RepositoryErrorCode.
//  23505 unique_violation          -> DUPLICATE
//  23503 foreign_key_violation     -> NOT_FOUND (referenced row missing)
//  55P03 lock_not_available        -> NOWAIT (row locked in another tx)
const PG_ERROR_CODE_TO_REPOSITORY_ERROR: Record<string, RepositoryErrorCode> = {
  "23505": RepositoryErrorCode.DUPLICATE,
  "23503": RepositoryErrorCode.NOT_FOUND,
  "55P03": RepositoryErrorCode.NOWAIT,
};

function getPgCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : null;
  }
  return null;
}

/**
 * Wraps an unknown driver error into a RepositoryError, mapping known
 * PostgreSQL SQLSTATE codes onto the domain error vocabulary. Errors that are
 * already RepositoryErrors are passed through unchanged.
 */
export function toRepositoryError(err: unknown): RepositoryError {
  if (err instanceof PostgresRepositoryError) {
    return err;
  }
  if (err && typeof err === "object" && "code" in err) {
    const existing = (err as { code?: unknown }).code;
    if (
      typeof existing === "string" &&
      Object.values(RepositoryErrorCode).includes(existing as RepositoryErrorCode)
    ) {
      return err as RepositoryError;
    }
  }

  const pgCode = getPgCode(err);
  const code = pgCode
    ? PG_ERROR_CODE_TO_REPOSITORY_ERROR[pgCode] ?? RepositoryErrorCode.UNKNOWN
    : RepositoryErrorCode.UNKNOWN;

  const message = err instanceof Error ? err.message : "Unknown database error.";
  return new PostgresRepositoryError(
    code,
    message,
    pgCode ? { sqlState: pgCode } : undefined,
  );
}
