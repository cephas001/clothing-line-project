// apps/api/tests/unit/pricing/RegionalPricingService.test.ts
//
// DOMAIN UNIT TESTS — RegionalPricingService (IPricingService).
//
// The pricing service resolves the AUTHORITATIVE price for a (variant, region)
// pair from the MoneyAmount repository. A missing regional price resolves to
// null (the consumer maps it to REGIONAL_PRICE_MISSING); there is NO fallback
// to a base price or to another region's price, and the client never supplies
// a price.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { RegionalPricingService } from "@api/infrastructure/services/RegionalPricingService";
import { InMemoryMoneyAmountRepository } from "../../fakes/InMemoryMoneyAmountRepository";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";

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

describe("RegionalPricingService", () => {
  it("returns the regional price in minor units when one is configured", async () => {
    const repo = new InMemoryMoneyAmountRepository();
    seedPrice(repo, "variant-1", "region-ng", 25000);
    const service = new RegionalPricingService(repo);

    const price = await service.getPriceForRegion("variant-1", "region-ng");
    expect(price).toBe(25000);
  });

  it("returns null when no price exists for the (variant, region) pair", async () => {
    const repo = new InMemoryMoneyAmountRepository();
    seedPrice(repo, "variant-1", "region-ng", 25000);
    const service = new RegionalPricingService(repo);

    const price = await service.getPriceForRegion("variant-1", "region-ke");
    expect(price).toBeNull();
  });

  it("returns null for an unknown variant (no fallback price)", async () => {
    const repo = new InMemoryMoneyAmountRepository();
    const service = new RegionalPricingService(repo);

    const price = await service.getPriceForRegion("variant-999", "region-ng");
    expect(price).toBeNull();
  });
});