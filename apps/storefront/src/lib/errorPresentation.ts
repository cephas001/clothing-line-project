// apps/storefront/src/lib/errorPresentation.ts
//
// F8 Part 4 — ONE presentation rule for every thrown error, so the UI never
// flattens a truthful message into "Something went wrong" and never leaks
// raw browser jargon ("Failed to fetch") where an actionable sentence exists.
//
// Strategy:
//   - An ApiError from the backend carries the canonical envelope message —
//     it is ALWAYS shown verbatim (INVALID_CREDENTIALS says why; the customer
//     should see exactly that).
//   - Transport failures (fetch TypeError, aborts) normalize to NETWORK_ERROR
//     with status 0 — they get one curated, truthful, actionable line.
//   - Anything else (non-Error junk thrown across a boundary) falls back to
//     the generic message — the only case where "Something went wrong." is
//     honest.

import { isApiError, normalizeApiError } from "./api/errors";

/** The single network-failure line used everywhere transport breaks. */
export const NETWORK_ERROR_MESSAGE =
  "We couldn't reach the store. Check your connection and try again.";

/**
 * The message to RENDER for any thrown value. Truthful backend messages pass
 * through untouched; only true transport failures are reworded.
 */
export function errorMessageOf(error: unknown): string {
  if (isApiError(error)) {
    // A normalized NETWORK_ERROR may still carry the raw browser message
    // ("Failed to fetch"); present the curated line instead. Any OTHER code
    // — including backend-sourced messages on real HTTP statuses — is truth.
    if (error.code === "NETWORK_ERROR" && error.status === 0) {
      return NETWORK_ERROR_MESSAGE;
    }
    return error.message;
  }
  // A raw Error that is not an ApiError is a thrown transport failure
  // (fetch rejects with TypeError("Failed to fetch")) — curated line.
  if (error instanceof Error) {
    return NETWORK_ERROR_MESSAGE;
  }
  // Non-Error junk thrown across a boundary: the ONLY honest generic case.
  return normalizeApiError(error).message;
}
