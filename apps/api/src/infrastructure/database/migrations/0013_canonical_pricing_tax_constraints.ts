// apps/api/src/infrastructure/database/migrations/0013_canonical_pricing_tax_constraints.ts
//
// L7-R — CANONICAL PRICING & TAX BOUNDS AS DATABASE CHECK CONSTRAINTS.
//
// The application domain (Region entity, MoneyAmount entity, moneyUtils,
// calculateTaxAmountMinor) already rejects invalid money and tax configuration
// at the boundary. This migration makes the DATABASE the final guard for the
// two canonical pricing/tax values, so a bug that bypasses the domain can never
// persist a financially invalid row:
//
//   - region.tax_rate  — the SINGLE canonical tax source (basis points). Bounds
//     [0, 10000] (0 = tax-exempt region, 10000 = 100%). A negative or >100%
//     rate is rejected by the engine regardless of which code path wrote it.
//   - money_amount.amount_minor — the canonical regional unit price (integer
//     minor units). A negative price is rejected by the engine. (Precision is
//     already guaranteed by the BIGINT column; this closes the sign gap.)
//
// The companion UNIQUE(variant_id, region_id) on money_amount (from 0001)
// already guarantees exactly ONE canonical price per (variant, region) — that
// constraint is asserted by the DB suite. This migration only adds the range
// CHECKs that were previously enforced solely at the application layer.
//
// Down drops both constraints. Existing migration history is untouched.

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("region")
    .addCheckConstraint(
      "region_tax_rate_range_check",
      sql`tax_rate >= 0 AND tax_rate <= 10000`,
    )
    .execute();

  await db.schema
    .alterTable("money_amount")
    .addCheckConstraint(
      "money_amount_nonnegative_check",
      sql`amount_minor >= 0`,
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("money_amount")
    .dropConstraint("money_amount_nonnegative_check")
    .execute();

  await db.schema
    .alterTable("region")
    .dropConstraint("region_tax_rate_range_check")
    .execute();
}
