// apps/api/tests/integration/payment/HistoricalIntegrity.test.ts
//
// INTEGRATION TESTS — payment obligations are FROZEN at initialization.
//
// Once a payment obligation is created, altering TODAY's product price,
// discount config, tax config, shipping rate, or region tax rate MUST NOT
// change the amount the customer is expected to pay. The webhook continues to
// validate against the frozen `payment.amountMinor`; an order finalized later
// records the frozen financial snapshot — never a reconstruction from current
// config.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { createPaymentHarness, buildDefaultPaymentCart } from "./harness";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import { buildFixedPromotion, buildPercentagePromotion } from "../../fixtures/promotionFactory";
import { buildRegion } from "../../fixtures/regionFactory";
import { Cart } from "@api/domain/entities/Cart";

const FROZEN_AMOUNT_MINOR = 61000;

/**
 * Simulate "today's config changed" after initialization: re-price the cart
 * (higher product prices, bigger discount, higher tax/shipping, no insurance)
 * and raise the region tax rate. The recomputed total is deliberately 90_000,
 * far from the frozen 61_000.
 */
function buildMutatedCart(id = "cart-1"): Cart {
  return buildCheckoutCart({
    id,
    customerId: "customer-1",
    email: "buyer@example.com",
    items: [
      { id: "line-1", variantId: "variant-1", quantity: 2, unitPriceMinor: 35000, title: "Classic Tee" },
      { id: "line-2", variantId: "variant-2", quantity: 1, unitPriceMinor: 20000, title: "Canvas Belt" },
    ],
    promotion: buildPercentagePromotion("SAVE10", 1000),
    taxAmountMinor: 6000,
    shippingAmountMinor: 4000,
    insuranceAmountMinor: 0,
  });
}

describe("Payment historical integrity — frozen obligation survives config changes", () => {
  it("altering today's prices/discount/tax/shipping does NOT change the frozen obligation amount", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    // Today's config changes: product prices, discount, tax, shipping all rise;
    // the region tax rate rises too.
    h.cartRepository.seed(buildMutatedCart("cart-1"));
    h.regionRepository.seed(
      buildRegion({ id: "region-ng", taxRate: 2000 }),
    );

    const recomputedToday = buildMutatedCart("cart-1")
      .computeAuthoritativeCheckoutBreakdown();
    // 90000 subtotal - 9000 (10%) + 6000 tax + 4000 shipping = 91000.
    expect(recomputedToday.totalMinor).toBe(91000);

    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(obligation!.amountMinor).toBe(FROZEN_AMOUNT_MINOR);
    expect(obligation!.breakdown).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 3000,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: FROZEN_AMOUNT_MINOR,
    });
  });

  it("the webhook still validates against the frozen amount, even after config changes", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    h.cartRepository.seed(buildMutatedCart("cart-1"));
    h.regionRepository.seed(buildRegion({ id: "region-ng", taxRate: 2000 }));

    // The correct webhook amount is the FROZEN obligation amount — passes.
    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: FROZEN_AMOUNT_MINOR,
        reportedCurrency: "ngn",
      }),
    ).resolves();

    // A webhook replaying today's recomputed (higher) amount is REJECTED —
    // the customer was never asked to pay 91_000.
    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: 91000,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("INVALID_PAYMENT_AMOUNT");
  });

  it("the finalized order records the FROZEN financial snapshot, not today's config", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    // Today's config drifts BEFORE the webhook arrives.
    h.cartRepository.seed(buildMutatedCart("cart-1"));
    h.regionRepository.seed(buildRegion({ id: "region-ng", taxRate: 2000 }));

    const order = await h.finalizeOrderTransaction.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: FROZEN_AMOUNT_MINOR,
      currency: "ngn",
      expectedAmountMinor: FROZEN_AMOUNT_MINOR,
      actorId: "system",
    });

    expect(order.transactionReference).toBe("CLP-checkout-cart-1");
    expect(order.totalAmountMinor).toBe(FROZEN_AMOUNT_MINOR);
    expect(order.currency).toBe("ngn");
    // FROZEN at initialization — today's recomputed values (91000/9000/6000/
    // 4000/0) must NOT appear.
    expect(order.subtotalMinor).toBe(60000);
    expect(order.discountMinor).toBe(5000);
    expect(order.taxMinor).toBe(3000);
    expect(order.shippingMinor).toBe(2500);
    expect(order.insuranceMinor).toBe(500);

    // The promotion snapshot records the applied (frozen) discount, not the
    // mutated promotion's value.
    expect(order.promotionSnapshot).not.toBeNull();
    expect(order.promotionSnapshot!.appliedDiscountMinor).toBe(5000);

    // The obligation is reconciled to captured in the same unit of work.
    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(obligation!.status).toBe("captured");
  });

  it("finalizing with an amount that drifted from the frozen obligation fails", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    h.cartRepository.seed(buildMutatedCart("cart-1"));

    await expect(() =>
      h.finalizeOrderTransaction.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: 91000,
        currency: "ngn",
        expectedAmountMinor: FROZEN_AMOUNT_MINOR,
        actorId: "system",
      }),
    ).rejectsWithCode("INVALID_PAYMENT_AMOUNT");
  });
});

describe("Payment historical integrity — idempotent finalization", () => {
  it("a duplicate webhook resolves to the SAME order without double-finalizing", async () => {
    const h = createPaymentHarness();
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const input = {
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: FROZEN_AMOUNT_MINOR,
      currency: "ngn",
      expectedAmountMinor: FROZEN_AMOUNT_MINOR,
      actorId: "system",
    };

    const first = await h.finalizeOrderTransaction.execute(input);
    const second = await h.finalizeOrderTransaction.execute(input);

    expect(second.id).toBe(first.id);
    expect(h.orderRepository.all).toHaveLength(1);
    const transaction = await h.transactionRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(transaction).toBeDefined();
    expect(transaction!.amountMinor).toBe(FROZEN_AMOUNT_MINOR);
  });
});