// apps/api/tests/integration/cart/AddCartLineItemPricingRules.test.ts
//
// INTEGRATION — AddCartLineItemUseCase resolves the line price from the
// AUTHORITATIVE regional pricing service (never from the client):
//   - the line item's unit price is the regional price for (variant, region)
//   - a missing regional price fails closed with REGIONAL_PRICE_MISSING and
//     leaves the cart untouched
//   - pricing is REGIONAL: a price configured for one region does not apply to
//     another region's cart

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import { ProductVariant } from "@api/domain/entities/ProductVariant";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import { RegionalPricingService } from "@api/infrastructure/services/RegionalPricingService";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryVariantRepository } from "../../fakes/InMemoryVariantRepository";
import { InMemoryMoneyAmountRepository } from "../../fakes/InMemoryMoneyAmountRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { AddCartLineItemUseCase } from "@api/use-cases/cart/AddCartLineItemUseCase";

function buildVariant(id: string, sku: string): ProductVariant {
  return new ProductVariant({
    id,
    productId: "product-1",
    sku,
    inventoryQuantity: 100,
    allowBackorder: false,
  });
}

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

function buildUseCase(
  cartRepository: InMemoryCartRepository,
  variantRepository: InMemoryVariantRepository,
  moneyAmountRepository: InMemoryMoneyAmountRepository,
): AddCartLineItemUseCase {
  return new AddCartLineItemUseCase(
    cartRepository,
    variantRepository,
    new RegionalPricingService(moneyAmountRepository),
    new InMemoryAuditLogService(),
    new SequenceIdGenerator(),
    new NoopLogger(),
    new InMemoryTransactionManager(),
  );
}

describe("AddCartLineItemUseCase — authoritative pricing", () => {
  it("prices the new line item at the regional price in minor units", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" })); // subtotal 60000
    const variantRepository = new InMemoryVariantRepository();
    variantRepository.seed(buildVariant("variant-3", "SKU-3"));
    const moneyAmountRepository = new InMemoryMoneyAmountRepository();
    seedPrice(moneyAmountRepository, "variant-3", "region-ng", 25000);
    const useCase = buildUseCase(
      cartRepository,
      variantRepository,
      moneyAmountRepository,
    );

    await expect(
      useCase.execute({ cartId: "cart-1", variantId: "variant-3", quantity: 1, actorId: "customer-1" }),
    ).resolves();

    const cart = await cartRepository.findById("cart-1");
    const line = cart!.getItem("id-1");
    expect(line!.variantId).toBe("variant-3");
    expect(line!.unitPriceMinor).toBe(25000);
    expect(cart!.cartTotalMinor).toBe(85000); // 60000 + 1x25000
  });

  it("fails closed with REGIONAL_PRICE_MISSING when no price exists for the region", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));
    const variantRepository = new InMemoryVariantRepository();
    variantRepository.seed(buildVariant("variant-3", "SKU-3"));
    const useCase = buildUseCase(
      cartRepository,
      variantRepository,
      new InMemoryMoneyAmountRepository(),
    );

    await expect(
      useCase.execute({ cartId: "cart-1", variantId: "variant-3", quantity: 1, actorId: "customer-1" }),
    ).rejectsWithCode("REGIONAL_PRICE_MISSING");

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.items).toHaveLength(2);
    expect(cart!.cartTotalMinor).toBe(60000);
  });

  it("does not fall back to another region's price (pricing is REGIONAL)", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(
      buildCheckoutCart({ id: "cart-1", regionId: "region-ke" }),
    );
    const variantRepository = new InMemoryVariantRepository();
    variantRepository.seed(buildVariant("variant-3", "SKU-3"));
    const moneyAmountRepository = new InMemoryMoneyAmountRepository();
    // Price exists ONLY for region-ng, never for region-ke.
    seedPrice(moneyAmountRepository, "variant-3", "region-ng", 25000);
    const useCase = buildUseCase(
      cartRepository,
      variantRepository,
      moneyAmountRepository,
    );

    await expect(
      useCase.execute({ cartId: "cart-1", variantId: "variant-3", quantity: 1, actorId: "customer-1" }),
    ).rejectsWithCode("REGIONAL_PRICE_MISSING");

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.items).toHaveLength(2);
    expect(cart!.cartTotalMinor).toBe(60000);
  });

  it("re-adding a variant records the current regional price on a fresh line", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));
    const variantRepository = new InMemoryVariantRepository();
    variantRepository.seed(buildVariant("variant-1", "SKU-1"));
    const moneyAmountRepository = new InMemoryMoneyAmountRepository();
    seedPrice(moneyAmountRepository, "variant-1", "region-ng", 25000);
    const useCase = buildUseCase(
      cartRepository,
      variantRepository,
      moneyAmountRepository,
    );

    await expect(
      useCase.execute({ cartId: "cart-1", variantId: "variant-1", quantity: 1, actorId: "customer-1" }),
    ).resolves();

    const cart = await cartRepository.findById("cart-1");
    const variantLines = cart!.items.filter((item) => item.variantId === "variant-1");
    expect(variantLines).toHaveLength(2);
    expect(variantLines[1].unitPriceMinor).toBe(25000);
    expect(cart!.cartTotalMinor).toBe(85000); // 60000 + 1x25000
  });
});