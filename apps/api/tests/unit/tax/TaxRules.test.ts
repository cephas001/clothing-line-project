// apps/api/tests/unit/tax/TaxRules.test.ts
//
// DOMAIN UNIT TESTS — Tax configuration and the authoritative tax math.
//
// The single authoritative formula is calculateTaxAmountMinor:
//   tax = floor(taxable_base_minor * rate_bps / 10000)
// with DETERMINISTIC floor rounding in integer minor units. Rates are stored
// as basis points on Region — the single canonical tax source for the checkout
// pipeline — and fail closed on invalid configuration.
//
// A missing/unconfigured region fails closed with REGION_NOT_FOUND — the
// service never invents a rate.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { calculateTaxAmountMinor } from "@api/utils/taxUtils";
import { Region } from "@api/domain/entities/Region";
import { RegionalTaxCalculationService } from "@api/infrastructure/services/RegionalTaxCalculationService";
import { InMemoryRegionRepository } from "../../fakes/InMemoryRegionRepository";
import { buildCheckoutCart } from "../../fixtures/cartFactory";

function buildRegion(id: string, taxRate: number): Region {
  return new Region({
    id,
    name: `Region ${id}`,
    currencyCode: "NGN",
    taxRate,
    paymentProviders: ["paystack"],
    fulfillmentProviders: ["shipbubble"],
  });
}

describe("calculateTaxAmountMinor (authoritative tax math)", () => {
  it("computes floor(base * rate / 10000) exactly", () => {
    expect(calculateTaxAmountMinor(60000, 750)).toBe(4500);
    expect(calculateTaxAmountMinor(60000, 1250)).toBe(7500);
    expect(calculateTaxAmountMinor(100, 1250)).toBe(12);
  });

  it("rounds DETERMINISTICALLY toward zero (fractional minor units dropped)", () => {
    expect(calculateTaxAmountMinor(100, 750)).toBe(7); // 7.5 -> 7
    expect(calculateTaxAmountMinor(1, 1)).toBe(0); // 0.0001 -> 0
    expect(calculateTaxAmountMinor(1, 9999)).toBe(0); // 0.9999 -> 0
    expect(calculateTaxAmountMinor(10000, 9999)).toBe(9999);
  });

  it("returns zero for a zero base or zero rate", () => {
    expect(calculateTaxAmountMinor(0, 750)).toBe(0);
    expect(calculateTaxAmountMinor(60000, 0)).toBe(0);
  });

  it("handles the 10000 basis-point boundary (100%)", () => {
    expect(calculateTaxAmountMinor(60000, 10000)).toBe(60000);
  });

  it("fails closed on a negative or non-integer base", () => {
    expect(() => calculateTaxAmountMinor(-1, 750)).toThrowWithCode(
      "NEGATIVE_AMOUNT",
    );
    expect(() => calculateTaxAmountMinor(1.5, 750)).toThrowWithCode(
      "NEGATIVE_AMOUNT",
    );
    expect(() =>
      calculateTaxAmountMinor(Number.MAX_SAFE_INTEGER + 1, 750),
    ).toThrowWithCode("NEGATIVE_AMOUNT");
  });

  it("fails closed on an out-of-range rate", () => {
    expect(() => calculateTaxAmountMinor(60000, 10001)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => calculateTaxAmountMinor(60000, -1)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
    expect(() => calculateTaxAmountMinor(60000, 12.5)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("fails closed on overflow instead of producing a broken amount", () => {
    expect(() =>
      calculateTaxAmountMinor(Number.MAX_SAFE_INTEGER, 10000),
    ).toThrowWithCode("INTERNAL_ERROR");
  });
});

describe("Region — tax rate configuration", () => {
  it("accepts a valid integer basis-point rate", () => {
    expect(buildRegion("region-ng", 1250).taxRate).toBe(1250);
  });

  it("accepts a zero rate (tax-exempt region)", () => {
    expect(buildRegion("region-ng", 0).taxRate).toBe(0);
  });

  it("rejects a negative tax rate", () => {
    expect(() => buildRegion("region-ng", -1)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a non-integer tax rate", () => {
    expect(() => buildRegion("region-ng", 12.5)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a malformed currency code with INVALID_CURRENCY", () => {
    expect(
      () =>
        new Region({
          id: "region-ng",
          name: "Lagos",
          currencyCode: "NG",
          taxRate: 1250,
          paymentProviders: ["paystack"],
          fulfillmentProviders: [],
        }),
    ).toThrowWithCode("INVALID_CURRENCY");
  });

  it("re-validates on updateTaxRate", () => {
    const region = buildRegion("region-ng", 1250);
    region.updateTaxRate(750);
    expect(region.taxRate).toBe(750);
    expect(() => region.updateTaxRate(-1)).toThrowWithCode("VALIDATION_ERROR");
    expect(() => region.updateTaxRate(1.5)).toThrowWithCode("VALIDATION_ERROR");
  });
});

describe("RegionalTaxCalculationService", () => {
  it("computes tax on the GROSS subtotal at the region's rate", async () => {
    const regions = new InMemoryRegionRepository();
    regions.seed(buildRegion("region-ng", 750));
    const service = new RegionalTaxCalculationService(regions);
    // fixture subtotal = 2x25000 + 1x10000 = 60000
    const cart = buildCheckoutCart({ regionId: "region-ng" });

    const tax = await service.calculateTaxForAddress(cart);
    expect(tax).toBe(4500); // floor(60000 * 750 / 10000)
  });

  it("returns zero when the region's tax rate is zero", async () => {
    const regions = new InMemoryRegionRepository();
    regions.seed(buildRegion("region-ng", 0));
    const service = new RegionalTaxCalculationService(regions);
    const cart = buildCheckoutCart({ regionId: "region-ng" });

    const tax = await service.calculateTaxForAddress(cart);
    expect(tax).toBe(0);
  });

  it("fails closed with REGION_NOT_FOUND when the region is unconfigured", async () => {
    const regions = new InMemoryRegionRepository();
    const service = new RegionalTaxCalculationService(regions);
    const cart = buildCheckoutCart({ regionId: "region-ke" });

    await expect(
      service.calculateTaxForAddress(cart),
    ).rejectsWithCode("REGION_NOT_FOUND");
  });
});