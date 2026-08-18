// apps/api/tests/integration/checkout/AuthoritativeCheckoutChain.test.ts
//
// INTEGRATION TESTS — the L7 authoritative checkout chain, end to end.
//
// The ONE authoritative breakdown (Cart.computeAuthoritativeCheckoutBreakdown)
// is the single source for every financial value:
//   1. authoritative TAX is computed by the tax service over the gross
//      subtotal and persisted on the cart (SetCheckoutShippingAddressUseCase);
//   2. the payment obligation consumes the authoritative FINAL TOTAL and
//      freezes every component + the charged line items + the shipping
//      snapshot;
//   3. the finalized order records the FROZEN snapshot — changing product
//      price, promotion, tax rate, or shipping AFTER checkout leaves the
//      historical order/payment unchanged.
//
// No controller, frontend, or payment adapter computes any amount: the gateway
// receives EXACTLY the values from the durable obligation.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import { buildFixedPromotion, buildPercentagePromotion } from "../../fixtures/promotionFactory";
import { buildRegion } from "../../fixtures/regionFactory";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryRegionRepository } from "../../fakes/InMemoryRegionRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { SetCheckoutShippingAddressUseCase } from "@api/use-cases/checkout/SetCheckoutShippingAddressUseCase";
import { RegionalTaxCalculationService } from "@api/infrastructure/services/RegionalTaxCalculationService";
import { createPaymentHarness } from "../payment/harness";
import type { Cart } from "@api/domain/entities/Cart";
import type { JsonObject } from "@api/domain/shared/json";

// The fixture's default shipping address, reused VERBATIM so the quote
// fingerprint (which includes the shipping address) stays current after
// SetCheckoutShippingAddressUseCase runs.
const ADDRESS: JsonObject = {
  firstName: "Ada",
  lastName: "Okafor",
  line1: "1 Marina Street",
  city: "Lagos",
  state: "Lagos",
  postalCode: "101001",
  countryCode: "NG",
  phone: "+2348000000000",
};

/** Payment-ready cart with NO tax computed yet (quotes + selection already recorded). */
function buildUntaxedCart(id = "cart-1"): Cart {
  return buildCheckoutCart({
    id,
    customerId: "customer-1",
    email: "buyer@example.com",
    promotion: buildFixedPromotion("SAVE5K", 5000),
    taxAmountMinor: null,
    shippingAmountMinor: 2500,
    insuranceAmountMinor: 500,
  });
}

/** "Today's config changed" after checkout: higher prices, bigger discount, higher tax/shipping. */
function buildDriftedCart(id = "cart-1"): Cart {
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

describe("Authoritative checkout chain — tax -> breakdown -> obligation -> snapshot", () => {
  it("computes authoritative tax on the gross subtotal and freezes it into the payment obligation", async () => {
    const cart = buildUntaxedCart();
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(cart);

    const regionRepository = new InMemoryRegionRepository();
    regionRepository.seed(buildRegion({ id: "region-ng", taxRate: 750 }));

    const setShippingAddress = new SetCheckoutShippingAddressUseCase(
      cartRepository,
      new RegionalTaxCalculationService(regionRepository),
      new InMemoryAuditLogService(),
      new SequenceIdGenerator(),
      new NoopLogger(),
      new InMemoryTransactionManager(),
    );

    await setShippingAddress.execute({
      cartId: "cart-1",
      shippingAddress: ADDRESS,
    });

    // Authoritative tax = floor(gross subtotal 60000 * 750 bps / 10000) = 4500.
    const taxedCart = await cartRepository.findById("cart-1");
    expect(taxedCart!.taxAmountMinor).toBe(4500);
    expect(taxedCart!.computeAuthoritativeCheckoutBreakdown()).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 4500,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: 62500,
    });

    // The payment obligation consumes the authoritative final total and freezes
    // every component. The same cart/repo are passed so the harness seeds the
    // already-taxed aggregate.
    const h = createPaymentHarness({
      cart,
      cartRepository,
      region: buildRegion({ id: "region-ng", taxRate: 750 }),
    });
    const result = await h.initializePaymentSession.execute({ cartId: "cart-1" });
    expect(result.reference).toBe("CLP-checkout-cart-1");

    const obligation = await h.paymentRepository.findByReference(
      "CLP-checkout-cart-1",
    );
    expect(obligation!.amountMinor).toBe(62500);
    expect(obligation!.breakdown).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 4500,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: 62500,
    });

    // The gateway receives EXACTLY the frozen obligation values — the payment
    // adapter never recalcs an amount.
    expect(h.paymentService.checkoutInitializations).toHaveLength(1);
    expect(h.paymentService.checkoutInitializations[0].amountMinor).toBe(62500);
    expect(h.paymentService.checkoutInitializations[0].currency).toBe("ngn");
  });

  it("the finalized order records the FROZEN snapshot; later config changes leave it unchanged", async () => {
    const cart = buildUntaxedCart();
    const cartRepository = new InMemoryCartRepository();
    cartRepository.seed(cart);

    const regionRepository = new InMemoryRegionRepository();
    regionRepository.seed(buildRegion({ id: "region-ng", taxRate: 750 }));

    const setShippingAddress = new SetCheckoutShippingAddressUseCase(
      cartRepository,
      new RegionalTaxCalculationService(regionRepository),
      new InMemoryAuditLogService(),
      new SequenceIdGenerator(),
      new NoopLogger(),
      new InMemoryTransactionManager(),
    );
    await setShippingAddress.execute({ cartId: "cart-1", shippingAddress: ADDRESS });

    const h = createPaymentHarness({
      cart,
      cartRepository,
      region: buildRegion({ id: "region-ng", taxRate: 750 }),
    });
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const order = await h.finalizeOrderTransaction.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: 62500,
      currency: "ngn",
      expectedAmountMinor: 62500,
      actorId: "system",
    });
    expect(order.totalAmountMinor).toBe(62500);
    expect(order.taxMinor).toBe(4500);

    // Today's config drifts AFTER checkout: product prices, promotion, tax,
    // shipping, and insurance all change (today's recomputed total = 91000).
    h.cartRepository.seed(buildDriftedCart("cart-1"));
    h.regionRepository.seed(buildRegion({ id: "region-ng", taxRate: 2000 }));

    const drifted = await h.cartRepository.findById("cart-1");
    expect(drifted!.computeAuthoritativeCheckoutBreakdown().totalMinor).toBe(91000);

    // The historical order keeps the FROZEN snapshot, never a reconstruction
    // from today's config.
    expect(order.totalAmountMinor).toBe(62500);
    expect(order.subtotalMinor).toBe(60000);
    expect(order.discountMinor).toBe(5000);
    expect(order.taxMinor).toBe(4500);
    expect(order.shippingMinor).toBe(2500);
    expect(order.insuranceMinor).toBe(500);
    expect(order.currency).toBe("ngn");

    // The webhook still validates against the frozen amount; replaying today's
    // recomputed amount is rejected — the customer was never asked to pay 91000.
    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: 62500,
        reportedCurrency: "ngn",
      }),
    ).resolves();
    await expect(() =>
      h.verifyPaymentEvent.execute({
        cartId: "cart-1",
        transactionReference: "CLP-checkout-cart-1",
        amountPaidMinor: 91000,
        reportedCurrency: "ngn",
      }),
    ).rejectsWithCode("INVALID_PAYMENT_AMOUNT");
  });
});