// apps/api/src/utils/moneyUtils.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";

/**
 * Shared, exact integer conversion helpers for financial inputs.
 *
 * All money in this codebase is integer minor units (INV-8). These helpers
 * replace the unsafe `Number(...)` / `Math.floor(Number(...))` coercion
 * patterns found in peripheral financial paths (draft orders, order edits,
 * swaps, returns, quotes). They FAIL CLOSED: a value that is not a safe
 * integer (a float, NaN, a malformed numeric string) is rejected with a
 * DomainError instead of being silently rounded to a different amount.
 */

/**
 * Convert a value to a non-negative safe integer in minor units (a money
 * amount that can never be negative). Throws VALIDATION_ERROR otherwise.
 */
export function toNonNegativeMinorUnits(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${field} must be a non-negative integer in minor units.`,
    );
  }
  return n;
}

/**
 * Convert a value to a positive safe integer (a quantity). Throws
 * VALIDATION_ERROR otherwise.
 */
export function toPositiveQuantity(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${field} must be a positive integer.`,
    );
  }
  return n;
}

/**
 * Convert a value to a non-negative safe integer (a count that may be zero,
 * e.g. a fulfilled quantity). Throws VALIDATION_ERROR otherwise.
 */
export function toNonNegativeInteger(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${field} must be a non-negative integer.`,
    );
  }
  return n;
}

/**
 * Convert a value to a safe integer of any sign (e.g. an edit variance or a
 * difference-due that may be a refund to the customer). Throws
 * VALIDATION_ERROR otherwise.
 */
export function toSignedSafeInteger(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${field} must be an integer in minor units.`,
    );
  }
  return n;
}
