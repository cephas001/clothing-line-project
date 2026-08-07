import { StructuredMeta } from "@api/domain/shared/contracts";

// apps/api/src/shared/errors/RepositoryError.ts

export enum RepositoryErrorCode {
  DUPLICATE = "DUPLICATE",
  NOT_FOUND = "NOT_FOUND",
  CONNECTION = "CONNECTION",
  TIMEOUT = "TIMEOUT",
  UNKNOWN = "UNKNOWN",
  LOCKED = "LOCKED",
  NOWAIT = "NOWAIT",
  UNAUTHORIZED = "UNAUTHORIZED",
  PERMISSION = "PERMISSION",
}

export interface RepositoryError extends Error {
  code: RepositoryErrorCode;
  // optional DB driver metadata for debugging
  meta?: StructuredMeta;
}
