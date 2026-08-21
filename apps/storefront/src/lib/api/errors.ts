// apps/storefront/src/lib/api/errors.ts
//
// Error normalization for the storefront API client.
//
// Every non-2xx response from the backend is a single canonical envelope:
//   { success: false, error: { code, message, details? } }
// where `code` is one of the enumerated ErrorCode values (see the OpenAPI
// StandardError schema). This module turns that envelope + the HTTP status
// into a typed `ApiError` the UI can branch on by `code` (e.g.
// INVALID_CREDENTIALS, ACCOUNT_LOCKED, CUSTOMER_ALREADY_EXISTS,
// REGIONAL_PRICE_MISSING, OUT_OF_STOCK, RESOURCE_NOT_FOUND, ...).
//
// Network/transport failures (no response, DNS, timeout) are normalized to a
// client-side `NETWORK_ERROR` code so callers can distinguish "backend said
// no" from "backend unreachable".

import type { StandardError } from "@clothing-line-project/shared-types";

/** The backend's enumerated error codes (mirrors the OpenAPI enum). */
export type ApiErrorCode =
  | StandardError["error"]["code"]
  | "NETWORK_ERROR"
  | "UNKNOWN_ERROR";

export interface ApiErrorOptions {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Typed error thrown by the API client for every failed request. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(options: ApiErrorOptions) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Coerce any thrown value into an ApiError. API responses already carry the
 * canonical code; unknown errors become NETWORK_ERROR so the UI never has to
 * handle raw Error objects.
 */
export function normalizeApiError(
  error: unknown,
  fallbackMessage = "Something went wrong.",
): ApiError {
  if (isApiError(error)) return error;
  if (error instanceof Error) {
    return new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: error.message,
    });
  }
  return new ApiError({
    status: 0,
    code: "NETWORK_ERROR",
    message: fallbackMessage,
  });
}