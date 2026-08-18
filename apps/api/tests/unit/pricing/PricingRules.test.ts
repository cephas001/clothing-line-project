// apps/api/tests/unit/pricing/PricingRules.test.ts
//
// DOMAIN UNIT TESTS — Pricing rules for the L7 regional pricing capability.
//
// Two layers are covered:
// 1. MoneyAmount — the minor-unit money primitive behind every price row.
//    All money is INTEGER minor units; non-integer, negative, or over-limit
//    amounts fail closed at construction and on every mutation.
// 2. RegionalPricingService — resolves the AUTHORITATIVE price for a
//    (variant, region) pair from the MoneyAmount repository. There is NO base
//    price and NO fallback to another region: the regional price IS the price.
//    A missing pair resolves to null, which consumers map to
//    REGIONAL_PRICE_MISSING.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import { RegionalPricingService } from "@api/infrastructure/services/RegionalPricingService";
import { InMemoryMoneyAmountRepository } from "../../fakes/InMemoryMoneyAmountRepository";

function seedPrice(
  repo: InMemoryMoneyAmountRepository,
  variantId: string,
  regionId: string,
  amountMinor: number,
): void {
  repo.seed(
    new MoneyAmount({
      id: `ma-${variantId}-${regionId}`,
      variantId,
      regionId,
      amountMinor,
    }),
  );
}

describe("MoneyAmount — minor-unit precision", () => {
  it("accepts an integer amount in the smallest currency denomination", () => {
    const moneyAmount = new MoneyAmount({
      id: "ma-1",
      variantId: "variant-1",
      regionId: "region-ng",
      amountMinor: 25000,
    });
    expect(moneyAmount.amountMinor).toBe(25000);
  });

  it("accepts zero and the maximum allowed amount", () => {
    const zero = new MoneyAmount({
      id: "ma-1",
      variantId: "variant-1",
      regionId: "region-ng",
      amountMinor: 0,
    });
    expect(zero.amountMinor).toBe(0);

    const max = new MoneyAmount({
      id: "ma-2",
      variantId: "variant-1",
      regionId: "region-ng",
      amountMinor: 1_000_000_000_00,
    });
    expect(max.amountMinor).toBe(1_000_000_000_00);
  });

  it("rejects a negative amount", () => {
    expect(
      () =>
        new MoneyAmount({
          id: "ma-1",
          variantId: "variant-1",
          regionId: "region-ng",
          amountMinor: -1,
        }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("rejects a non-integer amount (no fractional minor units)", () => {
    expect(
      () =>
        new MoneyAmount({
          id: "ma-1",
          variantId: "variant-1",
          regionId: "region-ng",
          amountMinor: 1.5,
        }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("rejects an amount above the allowed maximum", () => {
    expect(
      () =>
        new MoneyAmount({
          id: "ma-1",
          variantId: "variant-1",
          regionId: "region-ng",
          amountMinor: 1_000_000_000_01,
        }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("rejects a blank variant or region id", () => {
    expect(
      () =>
        new MoneyAmount({
          id: "ma-1",
          variantId: "  ",
          regionId: "region-ng",
          amountMinor: 100,
        }),
    ).toThrowWithCode("VALIDATION_ERROR");
    expect(
      () =>
        new MoneyAmount({
          id: "ma-1",
          variantId: "variant-1",
          regionId: "  ",
          amountMinor: 100,
        }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("re-validates on updateAmount", () => {
    const moneyAmount = new MoneyAmount({
      id: "ma-1",
      variantId: "variant-1",
      regionId: "region-ng",
      amountMinor: 100,
    });
    moneyAmount.updateAmount(200);
    expect(moneyAmount.amountMinor).toBe(200);
    expect(() => moneyAmount.updateAmount(-1)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => moneyAmount.updateAmount(1.5)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => moneyAmount.updateAmount(1_000_000_000_01)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });
});

describe("RegionalPricingService — authoritative (variant, region) resolution", () => {
  it("returns the configured regional price as the base price for that region", async () => {
    const repo = new InMemoryMoneyAmountRepository();
    seedPrice(repo, "variant-1", "region-ng", 25000);
    const service = new RegionalPricingService(repo);

    const price = await service.getPriceForRegion("variant-1", "region-ng");
    expect(price).toBe(25000);
  });

  it("returns distinct prices for the same variant in different regions", async () => {
    const repo = new InMemoryMoneyAmountRepository();
    seedPrice(repo, "variant-1", "region-ng", 25000);
    seedPrice(repo, "variant-1", "region-ke", 22000);
    const service = new RegionalPricingService(repo);

    expect(await service.getPriceForRegion("variant-1", "region-ng")).toBe(
      25000,
    );
    expect(await service.getPriceForRegion("variant-1", "region-ke")).toBe(
      22000,
    );
  });

  it("returns null when no price exists for the (variant, region) pair — no implicit base price", async () => {
    const repo = new InMemoryMoneyAmountRepository();
    seedPrice(repo, "variant-1", "region-ng", 25000);
    const service = new RegionalPricingService(repo);

    // A variant priced in one region has NO implicit price in another.
    expect(await service.getPriceForRegion("variant-1", "region-ke")).toBeNull();
  });

  it("returns null for an unknown variant (no fallback price)", async () => {
    const repo = new InMemoryMoneyAmountRepository();
    const service = new RegionalPricingService(repo);

    expect(await service.getPriceForRegion("variant-999", "region-ng")).toBeNull();
  });

  it("preserves minor-unit precision end to end (no float drift)", async () => {
    const repo = new InMemoryMoneyAmountRepository();
    seedPrice(repo, "variant-1", "region-ng", 1);
    seedPrice(repo, "variant-2", "region-ng", 1234567);
    const service = new RegionalPricingService(repo);

    expect(await service.getPriceForRegion("variant-1", "region-ng")).toBe(1);
    expect(await service.getPriceForRegion("variant-2", "region-ng")).toBe(
      1234567,
    );
  });
});