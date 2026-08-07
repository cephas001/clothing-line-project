// apps/api/src/utils/taxUtils.ts

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
