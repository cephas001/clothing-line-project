// apps/api/tests/integration/admin/PricingTaxPromotionAdmin.test.ts
//
// INTEGRATION — the admin write path for the L7 pricing & tax capability:
// ConfigureRegionalPricingUseCase and CreatePromotionRuleUseCase. Each
// validates referenced entities and money invariants, persists atomically
// through the transaction manager, and fails closed with stable DomainError
// codes.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { buildRegion } from "../../fixtures/regionFactory";
import { buildFixedPromotion } from "../../fixtures/promotionFactory";
import { ProductVariant } from "@api/domain/entities/ProductVariant";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import { RegionalPricingService } from "@api/infrastructure/services/RegionalPricingService";
import { ConfigureRegionalPricingUseCase } from "@api/use-cases/admin/ConfigureRegionalPricingUseCase";
import { CreatePromotionRuleUseCase } from "@api/use-cases/admin/CreatePromotionRuleUseCase";
import { InMemoryVariantRepository } from "../../fakes/InMemoryVariantRepository";
import { InMemoryRegionRepository } from "../../fakes/InMemoryRegionRepository";
import { InMemoryMoneyAmountRepository } from "../../fakes/InMemoryMoneyAmountRepository";
import { InMemoryPromotionRepository } from "../../fakes/InMemoryPromotionRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";

function buildVariant(id: string, sku: string): ProductVariant {
  return new ProductVariant({
    id,
    productId: "product-1",
    sku,
    inventoryQuantity: 100,
    allowBackorder: false,
  });
}

describe("ConfigureRegionalPricingUseCase — admin pricing write path", () => {
  function harness() {
    const variantRepository = new InMemoryVariantRepository();
    const regionRepository = new InMemoryRegionRepository();
    const moneyAmountRepository = new InMemoryMoneyAmountRepository();
    const auditLogService = new InMemoryAuditLogService();
    const useCase = new ConfigureRegionalPricingUseCase(
      variantRepository,
      regionRepository,
      moneyAmountRepository,
      auditLogService,
      new SequenceIdGenerator(),
      new NoopLogger(),
      new InMemoryTransactionManager(),
    );
    return { variantRepository, regionRepository, moneyAmountRepository, auditLogService, useCase };
  }

  it("persists the regional price and the pricing service resolves it (wiring proof)", async () => {
    const h = harness();
    h.variantRepository.seed(buildVariant("variant-1", "SKU-1"));
    h.regionRepository.seed(buildRegion());

    await expect(
      h.useCase.execute({ adminId: "admin-1", variantId: "variant-1", regionId: "region-ng", amountMinor: 25000 }),
    ).resolves();

    const price = await h.moneyAmountRepository.findRegionalPrice("variant-1", "region-ng");
    expect(price!.amountMinor).toBe(25000);
    const service = new RegionalPricingService(h.moneyAmountRepository);
    expect(await service.getPriceForRegion("variant-1", "region-ng")).toBe(25000);
    expect(h.auditLogService.actions()).toEqual(["REGIONAL_PRICE_SET"]);
  });

  it("rejects an unknown variant with RESOURCE_NOT_FOUND", async () => {
    const h = harness();
    h.regionRepository.seed(buildRegion());

    await expect(
      h.useCase.execute({ adminId: "admin-1", variantId: "variant-999", regionId: "region-ng", amountMinor: 25000 }),
    ).rejectsWithCode("RESOURCE_NOT_FOUND");
  });

  it("rejects an unknown region with RESOURCE_NOT_FOUND", async () => {
    const h = harness();
    h.variantRepository.seed(buildVariant("variant-1", "SKU-1"));

    await expect(
      h.useCase.execute({ adminId: "admin-1", variantId: "variant-1", regionId: "region-xx", amountMinor: 25000 }),
    ).rejectsWithCode("RESOURCE_NOT_FOUND");
  });

  it("rejects a negative amount with VALIDATION_ERROR (money invariant)", async () => {
    const h = harness();
    h.variantRepository.seed(buildVariant("variant-1", "SKU-1"));
    h.regionRepository.seed(buildRegion());

    await expect(
      h.useCase.execute({ adminId: "admin-1", variantId: "variant-1", regionId: "region-ng", amountMinor: -1 }),
    ).rejectsWithCode("VALIDATION_ERROR");
  });

  it("is a no-op when the price is already set (no duplicate write)", async () => {
    const h = harness();
    h.variantRepository.seed(buildVariant("variant-1", "SKU-1"));
    h.regionRepository.seed(buildRegion());
    h.moneyAmountRepository.seed(
      new MoneyAmount({ id: "ma-existing", variantId: "variant-1", regionId: "region-ng", amountMinor: 25000 }),
    );

    await expect(
      h.useCase.execute({ adminId: "admin-1", variantId: "variant-1", regionId: "region-ng", amountMinor: 25000 }),
    ).resolves();

    expect(h.moneyAmountRepository.all).toHaveLength(1);
  });
});

describe("CreatePromotionRuleUseCase — admin promotion write path", () => {
  function harness() {
    const promotionRepository = new InMemoryPromotionRepository();
    const auditLogService = new InMemoryAuditLogService();
    const useCase = new CreatePromotionRuleUseCase(
      promotionRepository,
      auditLogService,
      new SequenceIdGenerator(),
      new NoopLogger(),
      new InMemoryTransactionManager(),
    );
    return { promotionRepository, auditLogService, useCase };
  }

  it("persists a promotion with an uppercase-normalized code", async () => {
    const h = harness();

    await expect(
      h.useCase.execute({ adminId: "admin-1", code: "save10", discountValueMinor: 1000, discountType: "percentage", minimumSpendMinor: 5000 }),
    ).resolves();

    const saved = await h.promotionRepository.findByCode("SAVE10");
    expect(saved!.code).toBe("SAVE10");
    expect(saved!.discountType).toBe("percentage");
    expect(saved!.minimumSpendMinor).toBe(5000);
    expect(saved!.isActive).toBe(true);
    expect(h.auditLogService.actions()).toEqual(["PROMOTION_CREATE"]);
  });

  it("rejects a duplicate code with INVALID_OPERATION", async () => {
    const h = harness();
    h.promotionRepository.seed(buildFixedPromotion("SAVE10", 1000));

    await expect(
      h.useCase.execute({ adminId: "admin-1", code: "save10", discountValueMinor: 2000, discountType: "fixed_amount" }),
    ).rejectsWithCode("INVALID_OPERATION");
  });

  it("rejects an invalid discount type with VALIDATION_ERROR", async () => {
    const h = harness();

    await expect(
      h.useCase.execute({ adminId: "admin-1", code: "SAVE10", discountValueMinor: 1000, discountType: "bogo" as unknown as "percentage" }),
    ).rejectsWithCode("VALIDATION_ERROR");
  });

  it("rejects a negative discount value with VALIDATION_ERROR", async () => {
    const h = harness();

    await expect(
      h.useCase.execute({ adminId: "admin-1", code: "SAVE10", discountValueMinor: -1, discountType: "fixed_amount" }),
    ).rejectsWithCode("VALIDATION_ERROR");
  });

  it("rejects a percentage above 10000 basis points with VALIDATION_ERROR", async () => {
    const h = harness();

    await expect(
      h.useCase.execute({ adminId: "admin-1", code: "SAVE10", discountValueMinor: 10001, discountType: "percentage" }),
    ).rejectsWithCode("VALIDATION_ERROR");
  });
});