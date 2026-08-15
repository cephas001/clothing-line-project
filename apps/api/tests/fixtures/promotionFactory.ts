// apps/api/tests/fixtures/promotionFactory.ts

// Deterministic Promotion fixtures. All money is integer minor units;
// percentage discounts are expressed in basis points.

import { Promotion, PromotionProps } from "@api/domain/entities/Promotion";

export function buildFixedPromotion(
  code: string,
  valueMinor: number,
  overrides: Partial<PromotionProps> = {},
): Promotion {
  return new Promotion({
    id: "promo-fixed",
    code,
    discountType: "fixed_amount",
    discountValueMinor: valueMinor,
    minimumSpendMinor: 0,
    isActive: true,
    ...overrides,
  });
}

export function buildPercentagePromotion(
  code: string,
  basisPoints: number,
  overrides: Partial<PromotionProps> = {},
): Promotion {
  return new Promotion({
    id: "promo-pct",
    code,
    discountType: "percentage",
    discountValueMinor: basisPoints,
    minimumSpendMinor: 0,
    isActive: true,
    ...overrides,
  });
}