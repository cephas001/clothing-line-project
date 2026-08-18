// apps/api/tests/integration/cart/ApplyDiscountCodeRules.test.ts
//
// INTEGRATION — ApplyDiscountCodeUseCase enforces the promotion policy end to
// end through the repository + transaction-manager boundary:
//   - the promotion must exist AND be active (inactive/unknown -> VALIDATION_ERROR)
//   - the cart must meet the minimum spend (below -> VALIDATION_ERROR, at the
//     exact boundary -> applied)
//   - a promotion already applied to the cart cannot be re-applied
//     (duplicate -> INVALID_OPERATION)
//   - a DIFFERENT promotion replaces the existing one (single-promotion policy)
//   - codes are normalized (trim + uppercase)
// The discount that reaches the authoritative checkout breakdown is computed
// by the Promotion entity (floor division for percentages), never by the client.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import { buildFixedPromotion, buildPercentagePromotion } from "../../fixtures/promotionFactory";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryPromotionRepository } from "../../fakes/InMemoryPromotionRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { NoopLogger } from "../../fakes/NoopLogger";
import { ApplyDiscountCodeUseCase } from "@api/use-cases/cart/ApplyDiscountCodeUseCase";

function buildUseCase(
  cartRepository: InMemoryCartRepository,
  promotionRepository: InMemoryPromotionRepository,
): ApplyDiscountCodeUseCase {
  return new ApplyDiscountCodeUseCase(
    cartRepository,
    promotionRepository,
    new InMemoryAuditLogService(),
    new NoopLogger(),
    new InMemoryTransactionManager(),
  );
}

describe("ApplyDiscountCodeUseCase — promotion policy", () => {
  it("applies an active percentage promotion; the breakdown uses floor division", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" })); // subtotal 60000
    const promotionRepository = new InMemoryPromotionRepository();
    promotionRepository.seed(buildPercentagePromotion("SAVE10", 1000));
    const useCase = buildUseCase(cartRepository, promotionRepository);

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "SAVE10" }),
    ).resolves();

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.appliedPromotion!.code).toBe("SAVE10");
    // floor(60000 * 1000 / 10000) = 6000
    expect(cart!.computeAuthoritativeCheckoutBreakdown().discountMinor).toBe(6000);
  });

  it("applies an active fixed-amount promotion capped at the subtotal", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));
    const promotionRepository = new InMemoryPromotionRepository();
    promotionRepository.seed(buildFixedPromotion("SAVE50", 5000));
    const useCase = buildUseCase(cartRepository, promotionRepository);

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "SAVE50" }),
    ).resolves();

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.computeAuthoritativeCheckoutBreakdown().discountMinor).toBe(5000);
  });

  it("normalizes the code (trim + uppercase) before lookup", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));
    const promotionRepository = new InMemoryPromotionRepository();
    promotionRepository.seed(buildFixedPromotion("SAVE10", 5000));
    const useCase = buildUseCase(cartRepository, promotionRepository);

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "  save10  " }),
    ).resolves();

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.appliedPromotion!.code).toBe("SAVE10");
  });

  it("applies the promotion when the subtotal is EXACTLY at the minimum spend", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" })); // subtotal 60000
    const promotionRepository = new InMemoryPromotionRepository();
    promotionRepository.seed(
      buildFixedPromotion("SAVE10", 1000, { minimumSpendMinor: 60000 }),
    );
    const useCase = buildUseCase(cartRepository, promotionRepository);

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "SAVE10" }),
    ).resolves();
  });

  it("rejects a promotion below the minimum spend and leaves the cart untouched", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" })); // subtotal 60000
    const promotionRepository = new InMemoryPromotionRepository();
    promotionRepository.seed(
      buildFixedPromotion("SAVE10", 1000, { minimumSpendMinor: 60001 }),
    );
    const useCase = buildUseCase(cartRepository, promotionRepository);

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "SAVE10" }),
    ).rejectsWithCode("VALIDATION_ERROR");

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.appliedPromotion).toBeNull();
  });

  it("rejects an inactive promotion", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));
    const promotionRepository = new InMemoryPromotionRepository();
    promotionRepository.seed(
      buildFixedPromotion("SAVE10", 1000, { isActive: false }),
    );
    const useCase = buildUseCase(cartRepository, promotionRepository);

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "SAVE10" }),
    ).rejectsWithCode("VALIDATION_ERROR");

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.appliedPromotion).toBeNull();
  });

  it("rejects an unknown promotion code", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));
    const useCase = buildUseCase(cartRepository, new InMemoryPromotionRepository());

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "NOPE" }),
    ).rejectsWithCode("VALIDATION_ERROR");

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.appliedPromotion).toBeNull();
  });

  it("rejects re-applying the SAME promotion to the cart", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" }));
    const promotionRepository = new InMemoryPromotionRepository();
    promotionRepository.seed(buildFixedPromotion("SAVE10", 1000));
    const useCase = buildUseCase(cartRepository, promotionRepository);

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "SAVE10" }),
    ).resolves();

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "SAVE10" }),
    ).rejectsWithCode("INVALID_OPERATION");

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.appliedPromotion!.code).toBe("SAVE10");
  });

  it("replaces an existing promotion when a DIFFERENT one is applied (single-promotion policy)", async () => {
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(buildCheckoutCart({ id: "cart-1" })); // subtotal 60000
    const promotionRepository = new InMemoryPromotionRepository();
    promotionRepository.seed(buildPercentagePromotion("SAVE10", 1000));
    promotionRepository.seed(
      buildPercentagePromotion("SAVE20", 2000, { id: "promo-pct-2" }),
    );
    const useCase = buildUseCase(cartRepository, promotionRepository);

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "SAVE10" }),
    ).resolves();

    await expect(
      useCase.execute({ actorId: "admin-1", cartId: "cart-1", code: "SAVE20" }),
    ).resolves();

    const cart = await cartRepository.findById("cart-1");
    expect(cart!.appliedPromotion!.code).toBe("SAVE20");
    // The new promotion's discount replaces the old one: floor(60000*2000/10000) = 12000
    expect(cart!.computeAuthoritativeCheckoutBreakdown().discountMinor).toBe(12000);
  });
});