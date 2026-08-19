// apps/api/src/utils/taxUtils.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";

/**
 * Validate tax rate expressed in basis points.
 * - Must be integer
 * - Must be between 0 and 10000 (0% - 100%)
 */
export function validateTaxRateBasisPoints(value: number): boolean {
  if (!Number.isInteger(value)) return false;
  if (value < 0) return false;
  if (value > 10000) return false;
  return true;
}

/**
 * calculateTaxAmountMinor
 *
 * The SINGLE authoritative tax calculation primitive for the checkout pipeline.
 * - Computes tax on a caller-supplied taxable base expressed in minor units at
 *   a rate expressed in basis points (10000 = 100%).
 * - This is a PURE arithmetic primitive: it only computes `floor(base *
 *   rate / 10000)`. It does NOT resolve a rate, choose a base, or become a
 *   grand checkout calculator. The BASE is the caller's responsibility — in
 *   this codebase RegionalTaxCalculationService passes the GROSS subtotal
 *   (`Cart.cartTotalMinor`, pre-discount) as the taxable base.
 * - Rounding is DETERMINISTIC floor toward zero; all money is integer minor
 *   units (no parseFloat, no Math.round on money).
 * - Fail-closed: a non-integer/negative base or an out-of-range rate throws
 *   a DomainError instead of silently inventing a tax amount.
 */
export function calculateTaxAmountMinor(
  taxableBaseMinor: number,
  rateBasisPoints: number,
): number {
  if (!Number.isSafeInteger(taxableBaseMinor) || taxableBaseMinor < 0) {
    throw new DomainError(
      "NEGATIVE_AMOUNT",
      "Tax base must be a non-negative safe integer in minor units.",
    );
  }
  if (!validateTaxRateBasisPoints(rateBasisPoints)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Tax rate must be an integer between 0 and 10000 basis points.",
    );
  }
  const product = taxableBaseMinor * rateBasisPoints;
  if (!Number.isSafeInteger(product)) {
    throw new DomainError(
      "INTERNAL_ERROR",
      "Tax calculation overflow; the taxable base is too large.",
    );
  }
  return Math.floor(product / 10000);
}
