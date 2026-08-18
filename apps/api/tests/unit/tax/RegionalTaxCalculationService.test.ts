// apps/api/tests/unit/tax/RegionalTaxCalculationService.test.ts
//
// DOMAIN UNIT TESTS — RegionalTaxCalculationService (ITaxCalculationService)
// and the single authoritative tax math (calculateTaxAmountMinor).
//
// Tax = floor(gross subtotal * rate_bps / 10000), integer minor units, and the
// base is the GROSS subtotal (cart.cartTotalMinor). A missing/unconfigured
// region fails closed with REGION_NOT_FOUND; an invalid base or rate fails
// closed with a stable DomainError code.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { RegionalTaxCalculationService } from "@api/infrastructure/services/RegionalTaxCalculationService";
import { calculateTaxAmountMinor } from "@api/utils/taxUtils";
import { InMemoryRegionRepository } from "../../fakes/InMemoryRegionRepository";
import { Region } from "@api/domain/entities/Region";
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

  it("fails closed on a negative or non-integer base", () => {
    expect(() => calculateTaxAmountMinor(-1, 750)).toThrowWithCode(
      "NEGATIVE_AMOUNT",
    );
    expect(() => calculateTaxAmountMinor(1.5, 750)).toThrowWithCode(
      "NEGATIVE_AMOUNT",
    );
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