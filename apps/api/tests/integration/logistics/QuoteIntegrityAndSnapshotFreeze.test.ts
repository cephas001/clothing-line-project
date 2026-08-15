// apps/api/tests/integration/logistics/QuoteIntegrityAndSnapshotFreeze.test.ts
//
// L6 Part 3 — shipping-quote integrity + shipping-snapshot freeze.
//
// Proves the checkout shipping boundary is financially sealed:
//   - the client only ever sees/selects provider-neutral quotes and can NEVER
//     supply an amount, currency, courier, or request token;
//   - a stale/forged quote, or a cart mutated after quoting, is never accepted;
//   - the ORDER finalization carries the FROZEN snapshot from the durable
//     payment obligation — today's cart or today's rates can never change what
//     a finalized order agreed to pay for shipping.

import { CartLineItem } from "@api/domain/entities/CartLineItem";
import { buildFixedPromotion } from "../../fixtures/promotionFactory";
import { buildCartWithoutShipping, buildCheckoutCart } from "../../fixtures/cartFactory";
import {
  buildShippingQuote,
  createLogisticsHarness,
} from "./logisticsHarness";
import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { createPaymentHarness } from "../payment/harness";

describe("L6 Part 3 — shipping quote integrity", () => {
  it("client receives provider-neutral quotes and selects a server-validated amount", async () => {
    const h = createLogisticsHarness({
      cart: buildCartWithoutShipping({ id: "cart-q" }),
    });
    h.logisticsService.rates = [
      buildShippingQuote({
        id: "quote-a",
        serviceLevel: "Express",
        amountMinor: 2500,
        currency: "ngn",
        etaDays: 3,
        courierId: "courier-1",
        serviceCode: "SC-EXPRESS",
        requestToken: "token-a",
      }),
      buildShippingQuote({
        id: "quote-b",
        serviceLevel: "Economy",
        amountMinor: 1500,
        currency: "ngn",
        etaDays: 5,
        courierId: "courier-2",
        serviceCode: "SC-ECONOMY",
        requestToken: "token-b",
      }),
    ];

    const quotes = await h.retrieveDynamicShippingQuotes.execute({
      cartId: "cart-q",
    });
    expect(quotes).toHaveLength(2);
    for (const quote of quotes) {
      const record = quote as unknown as Record<string, unknown>;
      // Provider selection data never crosses the client boundary.
      expect(record.courierId).toBeUndefined();
      expect(record.serviceCode).toBeUndefined();
      expect(record.requestToken).toBeUndefined();
      expect(record.amountMinor).toBeDefined();
      expect(record.currency).toBeDefined();
    }

    const selected = await h.selectShippingOption.execute({
      cartId: "cart-q",
      quoteId: "quote-a",
    });
    expect(selected.quoteId).toBe("quote-a");
    expect(selected.amountMinor).toBe(2500);

    // The durable cart selection reflects the SERVER quote, verbatim.
    expect(h.cart.hasShippingSelection).toBe(true);
    expect(h.cart.shippingAmountMinor).toBe(2500);
    expect(h.cart.shippingCourierId).toBe("courier-1");
    expect(h.cart.shippingServiceCode).toBe("SC-EXPRESS");
    expect(h.cart.shippingRequestToken).toBe("token-a");
    expect(h.cart.shippingCurrency).toBe("ngn");
    expect(h.cart.isShippingSelectionConsistent()).toBe(true);
    expect(h.cart.isShippingQuoteCurrent()).toBe(true);
    expect(h.auditLogService.actions().includes("SHIPPING_OPTION_SELECTED")).toBe(true);
  });

  it("rejects a forged quote id with INVALID_STATE and leaves no selection", async () => {
    const h = createLogisticsHarness({
      cart: buildCartWithoutShipping({ id: "cart-q" }),
    });
    h.logisticsService.rates = [buildShippingQuote()];
    await h.retrieveDynamicShippingQuotes.execute({ cartId: "cart-q" });

    await expect(() =>
      h.selectShippingOption.execute({ cartId: "cart-q", quoteId: "quote-FORGED" }),
    ).rejectsWithCode("INVALID_STATE");
    expect(h.cart.hasShippingSelection).toBe(false);
  });

  it("selection never echoes provider fields — amount/courier/token are server-side", async () => {
    const h = createLogisticsHarness({
      cart: buildCartWithoutShipping({ id: "cart-q" }),
    });
    h.logisticsService.rates = [
      buildShippingQuote({
        id: "quote-a",
        amountMinor: 2500,
        courierId: "courier-1",
        serviceCode: "SC-EXPRESS",
        requestToken: "token-a",
      }),
    ];
    await h.retrieveDynamicShippingQuotes.execute({ cartId: "cart-q" });
    const selected = await h.selectShippingOption.execute({
      cartId: "cart-q",
      quoteId: "quote-a",
    });

    // The application-level result carries only selectable/display fields.
    const result = selected as unknown as Record<string, unknown>;
    expect(result.courierId).toBeUndefined();
    expect(result.serviceCode).toBeUndefined();
    expect(result.requestToken).toBeUndefined();

    // The durable selection exactly matches the server quote — the client
    // payload (cartId + quoteId) could never have influenced any of these.
    expect(h.cart.shippingAmountMinor).toBe(2500);
    expect(h.cart.shippingCourierId).toBe("courier-1");
    expect(h.cart.shippingServiceCode).toBe("SC-EXPRESS");
    expect(h.cart.shippingRequestToken).toBe("token-a");
  });

  it("a re-priced quote invalidates the prior selection; re-selection requires a re-fetch", async () => {
    const h = createLogisticsHarness({
      cart: buildCartWithoutShipping({ id: "cart-q" }),
    });
    h.logisticsService.rates = [buildShippingQuote({ amountMinor: 2500 })];
    await h.retrieveDynamicShippingQuotes.execute({ cartId: "cart-q" });
    await h.selectShippingOption.execute({ cartId: "cart-q", quoteId: "quote-a" });
    expect(h.cart.hasShippingSelection).toBe(true);

    // The provider re-prices the same quote id; the persisted list changes.
    h.logisticsService.rates = [buildShippingQuote({ amountMinor: 3500 })];
    await h.retrieveDynamicShippingQuotes.execute({ cartId: "cart-q" });

    // The stale 2500 selection is cleared — never silently carried forward.
    expect(h.cart.hasShippingSelection).toBe(false);

    // Selecting the same quote id again requires the fresh list.
    await h.selectShippingOption.execute({ cartId: "cart-q", quoteId: "quote-a" });
    expect(h.cart.shippingAmountMinor).toBe(3500);
  });

  it("a cart mutated after quoting refuses selection (stale fingerprint)", async () => {
    const h = createLogisticsHarness({
      cart: buildCartWithoutShipping({ id: "cart-q" }),
    });
    h.logisticsService.rates = [buildShippingQuote()];
    await h.retrieveDynamicShippingQuotes.execute({ cartId: "cart-q" });
    await h.selectShippingOption.execute({ cartId: "cart-q", quoteId: "quote-a" });
    expect(h.cart.isShippingQuoteCurrent()).toBe(true);

    // The customer changes a line quantity after the quotes were fetched.
    h.cart.addOrUpdateItem(
      new CartLineItem({
        id: "line-1",
        cartId: "cart-q",
        variantId: "variant-1",
        quantity: 3,
        unitPriceMinor: 25000,
        title: "Classic Tee",
        createdAt: new Date().toISOString(),
      }),
    );
    expect(h.cart.isShippingQuoteCurrent()).toBe(false);

    await expect(() =>
      h.selectShippingOption.execute({ cartId: "cart-q", quoteId: "quote-a" }),
    ).rejectsWithCode("INVALID_STATE");
  });

  it("a zero-amount (free) shipping quote is a valid selection", async () => {
    const h = createLogisticsHarness({
      cart: buildCartWithoutShipping({ id: "cart-q" }),
    });
    h.logisticsService.rates = [
      buildShippingQuote({
        id: "quote-free",
        amountMinor: 0,
        courierId: "courier-1",
        serviceCode: "SC-FREE",
        requestToken: "token-free",
      }),
    ];
    await h.retrieveDynamicShippingQuotes.execute({ cartId: "cart-q" });
    await h.selectShippingOption.execute({ cartId: "cart-q", quoteId: "quote-free" });

    expect(h.cart.hasShippingSelection).toBe(true);
    expect(h.cart.shippingAmountMinor).toBe(0);
  });
});

describe("L6 Part 3 — shipping snapshot freeze at finalization", () => {
  it("finalized order carries the FROZEN snapshot, never today's cart", async () => {
    const h = createPaymentHarness({
      cart: buildCheckoutCart({
        id: "cart-1",
        promotion: buildFixedPromotion("SAVE5K", 5000),
        taxAmountMinor: 3000,
        shippingAmountMinor: 2500,
        insuranceAmountMinor: 500,
      }),
    });
    await h.initializePaymentSession.execute({ cartId: "cart-1" });

    const obligation = h.paymentRepository.all[0];
    const frozen = obligation.metadata?.shippingSnapshot;
    expect(frozen).toBeDefined();

    // Drift the cart AFTER the obligation froze: a re-priced quote + a
    // different courier/token are applied to the cart entity directly.
    h.cart.recordShippingQuotes([
      {
        id: "quote-drift",
        serviceLevel: "Drift",
        amountMinor: 99999,
        currency: "ngn",
        etaDays: 1,
        courierId: "courier-DRIFT",
        serviceCode: "SC-DRIFT",
        requestToken: "token-drift",
      },
    ]);
    h.cart.applySelectedShippingQuote({
      quoteId: "quote-drift",
      courierId: "courier-DRIFT",
      serviceCode: "SC-DRIFT",
      requestToken: "token-drift",
      amountMinor: 99999,
      serviceLevel: "Drift",
      currency: "ngn",
      etaDays: 1,
    });
    expect(h.cart.shippingAmountMinor).toBe(99999);

    const order = await h.finalizeOrderTransaction.execute({
      cartId: "cart-1",
      transactionReference: "CLP-checkout-cart-1",
      amountPaidMinor: 61000,
      currency: "ngn",
      expectedAmountMinor: 61000,
    });

    // The order snapshots the FROZEN obligation values, not the drifted cart.
    expect(order.shippingSnapshot).not.toBeNull();
    if (!order.shippingSnapshot) {
      throw new Error("expected order shipping snapshot");
    }
    expect(order.shippingSnapshot.requestToken).toBe("request-token-1");
    expect(order.shippingSnapshot.selection.quoteId).toBe("quote-1");
    expect(order.shippingSnapshot.selection.courierId).toBe("courier-1");
    expect(order.shippingSnapshot.selection.serviceCode).toBe("SC-EXPRESS");
    expect(order.shippingSnapshot.selection.amountMinor).toBe(2500);
    expect(order.shippingSnapshot.selection.currency).toBe("ngn");
    expect(order.shippingSnapshot.destination.name).toBe("Ada Okafor");
    expect(order.shippingSnapshot.parcelItems).toHaveLength(2);

    // No live quote recalculation: the frozen amount survived cart drift, and
    // the order's frozen shipping total agrees with the obligation.
    expect(order.shippingSnapshot.selection.amountMinor).toBe(2500);
    expect(order.shippingSnapshot.selection.amountMinor).not.toBe(
      h.cart.shippingAmountMinor ?? 0,
    );
    expect(order.shippingMinor).toBe(2500);
    expect(order.shippingMinor).not.toBe(h.cart.shippingAmountMinor ?? 0);
  });
});