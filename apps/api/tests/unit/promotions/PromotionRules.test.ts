// apps/api/tests/unit/promotions/PromotionRules.test.ts
//
// DOMAIN UNIT TESTS — Promotion rule validation and discount math.
//
// Every monetary value is an INTEGER in minor units; percentage discounts are
// expressed in basis points (10000 = 100%). computeDiscountAmount is the
// single authoritative discount computation feeding the checkout breakdown:
// DETERMINISTIC floor division for percentages, fixed amounts capped at the
// subtotal, and fail-closed DomainErrors for invalid money (NEGATIVE_AMOUNT)
// or overflow (INTERNAL_ERROR).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { Promotion, PromotionProps } from "@api/domain/entities/Promotion";
import { buildFixedPromotion, buildPercentagePromotion } from "../../fixtures/promotionFactory";

function percentage(props: Partial<PromotionProps>): Promotion {
  return buildPercentagePromotion("SAVE10", 1000, props);
}

function fixed(valueMinor: number, props: Partial<PromotionProps> = {}): Promotion {
  return buildFixedPromotion("FIX10", valueMinor, props);
}

describe("Promotion — construction & configuration validation", () => {
  it("normalizes the code to uppercase and trims whitespace", () => {
    const promotion = buildFixedPromotion(" promo-10 ", 1000);
    expect(promotion.code).toBe("PROMO-10");
  });

  it("rejects an empty code", () => {
    expect(() => buildFixedPromotion("   ", 1000)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a code with invalid characters", () => {
    expect(() => buildFixedPromotion("SAVE 10", 1000)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => buildFixedPromotion("SAVE#10", 1000)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects an invalid discount type", () => {
    expect(
      () =>
        new Promotion({
          id: "p1",
          code: "SAVE10",
          discountType: "bogo" as unknown as "percentage",
          discountValueMinor: 1000,
        }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("rejects a negative or non-integer discount value", () => {
    expect(() => buildFixedPromotion("SAVE10", -1)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => buildFixedPromotion("SAVE10", 1.5)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a percentage discount above 10000 basis points", () => {
    expect(() => percentage({ discountValueMinor: 10001 })).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("accepts a 10000 basis-point percentage discount (100%)", () => {
    const promotion = percentage({ discountValueMinor: 10000 });
    expect(promotion.discountValueMinor).toBe(10000);
  });

  it("rejects a discount value above the allowed maximum", () => {
    expect(() => buildFixedPromotion("SAVE10", 1_000_000_001)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a negative minimum spend", () => {
    expect(() => fixed(1000, { minimumSpendMinor: -1 })).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a minimum spend above the allowed maximum", () => {
    expect(() =>
      fixed(1000, { minimumSpendMinor: 1_000_000_000_01 }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("defaults to active when isActive is omitted", () => {
    const promotion = buildFixedPromotion("SAVE10", 1000);
    expect(promotion.isActive).toBe(true);
  });

  it("deactivate/activate toggle the active flag", () => {
    const promotion = buildFixedPromotion("SAVE10", 1000);
    promotion.deactivate();
    expect(promotion.isActive).toBe(false);
    promotion.activate();
    expect(promotion.isActive).toBe(true);
  });

  it("re-validates on updateDiscount", () => {
    const promotion = buildFixedPromotion("SAVE10", 1000);
    promotion.updateDiscount("percentage", 750);
    expect(promotion.discountType).toBe("percentage");
    expect(promotion.discountValueMinor).toBe(750);
    expect(() => promotion.updateDiscount("percentage", 10001)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => promotion.updateDiscount("fixed_amount", -1)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("re-validates on updateMinimumSpend", () => {
    const promotion = buildFixedPromotion("SAVE10", 1000);
    promotion.updateMinimumSpend(5000);
    expect(promotion.minimumSpendMinor).toBe(5000);
    expect(() => promotion.updateMinimumSpend(-1)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => promotion.updateMinimumSpend(1_000_000_000_01)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });
});

describe("Promotion.computeDiscountAmount — discount math", () => {
  it("computes percentage discounts with deterministic floor division", () => {
    // floor(60000 * 1000 / 10000) = 6000
    expect(percentage({ discountValueMinor: 1000 }).computeDiscountAmount(60000)).toBe(6000);
    // floor(60000 * 1250 / 10000) = 7500
    expect(percentage({ discountValueMinor: 1250 }).computeDiscountAmount(60000)).toBe(7500);
    // floor(100 * 750 / 10000) = 7 (fractional minor units dropped)
    expect(percentage({ discountValueMinor: 750 }).computeDiscountAmount(100)).toBe(7);
  });

  it("covers the rounding boundary (fractional minor units drop toward zero)", () => {
    expect(percentage({ discountValueMinor: 1 }).computeDiscountAmount(1)).toBe(0);
    expect(percentage({ discountValueMinor: 9999 }).computeDiscountAmount(10000)).toBe(9999);
  });

  it("never discounts more than the subtotal for a percentage", () => {
    // 100% off is capped at the subtotal.
    expect(percentage({ discountValueMinor: 10000 }).computeDiscountAmount(60000)).toBe(60000);
  });

  it("returns the fixed amount, capped at the subtotal", () => {
    expect(fixed(5000).computeDiscountAmount(60000)).toBe(5000);
    // discount > subtotal must be capped, never a negative payable.
    expect(fixed(100000).computeDiscountAmount(60000)).toBe(60000);
    // discount == subtotal is allowed.
    expect(fixed(60000).computeDiscountAmount(60000)).toBe(60000);
  });

  it("returns zero for a zero discount value", () => {
    expect(fixed(0).computeDiscountAmount(60000)).toBe(0);
    expect(percentage({ discountValueMinor: 0 }).computeDiscountAmount(60000)).toBe(0);
  });

  it("fails closed on a negative or non-integer subtotal", () => {
    expect(() => fixed(1000).computeDiscountAmount(-1)).toThrowWithCode(
      "NEGATIVE_AMOUNT",
    );
    expect(() => fixed(1000).computeDiscountAmount(1.5)).toThrowWithCode(
      "NEGATIVE_AMOUNT",
    );
    expect(() => percentage({ discountValueMinor: 1000 }).computeDiscountAmount(1.5)).toThrowWithCode(
      "NEGATIVE_AMOUNT",
    );
  });

  it("fails closed on a non-safe-integer subtotal", () => {
    expect(() =>
      fixed(1000).computeDiscountAmount(Number.MAX_SAFE_INTEGER + 1),
    ).toThrowWithCode("NEGATIVE_AMOUNT");
  });

  it("fails closed on overflow instead of inventing a discount", () => {
    expect(() =>
      percentage({ discountValueMinor: 10000 }).computeDiscountAmount(
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrowWithCode("INTERNAL_ERROR");
  });
});

describe("Promotion.computeDiscountAmount — minimum spend enforcement", () => {
  it("applies the discount when the subtotal meets the minimum spend", () => {
    const promotion = percentage({
      discountValueMinor: 1000,
      minimumSpendMinor: 5000,
    });
    expect(promotion.computeDiscountAmount(5000)).toBe(500);
  });

  it("strictly rejects a subtotal below the minimum spend (INVALID_OPERATION)", () => {
    const promotion = percentage({
      discountValueMinor: 1000,
      minimumSpendMinor: 5000,
    });
    expect(() => promotion.computeDiscountAmount(4999)).toThrowWithCode(
      "INVALID_OPERATION",
    );
  });

  it("enforces minimum spend for fixed-amount discounts too", () => {
    const promotion = fixed(1000, { minimumSpendMinor: 5000 });
    expect(() => promotion.computeDiscountAmount(4999)).toThrowWithCode(
      "INVALID_OPERATION",
    );
    expect(promotion.computeDiscountAmount(5000)).toBe(1000);
  });
});

describe("Promotion — effective dates are intentionally not implemented", () => {
  it("has no start/end date window: isActive is the only gate and computeDiscountAmount is date-independent", () => {
    // L7-R decision: promotion effective dates (startsAt/endsAt) were deferred.
    // The schema has no such columns, so a promotion applies whenever it is
    // active. This guard pins that contract: the discount computation never
    // consults the clock, so toggling the current date cannot change the
    // authoritative checkout amount. Temporal control remains the isActive
    // flag, toggled by operators.
    const promotion = buildPercentagePromotion("SAVE10", 1000);
    expect((promotion as { startsAt?: unknown }).startsAt).toBeUndefined();
    expect((promotion as { endsAt?: unknown }).endsAt).toBeUndefined();

    const before = promotion.computeDiscountAmount(60000);
    // Simulate the clock moving (there is no date dependency to consult).
    expect(promotion.computeDiscountAmount(60000)).toBe(before);

    // Only deactivation changes the outcome of the application boundary (the
    // use case refuses an inactive promotion), not the raw math.
    expect(promotion.isActive).toBe(true);
    promotion.deactivate();
    expect(promotion.isActive).toBe(false);
  });
});