// apps/api/tests/unit/cart/CartCheckoutBreakdown.test.ts
//
// DOMAIN UNIT TESTS — Cart.computeAuthoritativeCheckoutBreakdown.
//
// The cart computes the ONE authoritative financial breakdown that becomes the
// durable payment obligation, the exact gateway amount, and the expected
// webhook amount. It must equal `subtotal - discount + tax + shipping +
// insurance`, all in integer minor units, sourced ONLY from server state (line
// prices, Promotion config, persisted tax/shipping/insurance) — never from the
// client.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { buildCheckoutCart } from "../../fixtures/cartFactory";
import { buildFixedPromotion, buildPercentagePromotion } from "../../fixtures/promotionFactory";

describe("Cart.computeAuthoritativeCheckoutBreakdown", () => {
  it("computes subtotal - discount + tax + shipping + insurance exactly", () => {
    // items 2x25000 + 1x10000 = 60000; fixed discount 5000; tax 3000;
    // shipping 2500; insurance 500 -> total 61000.
    const cart = buildCheckoutCart({
      id: "cart-1",
      promotion: buildFixedPromotion("SAVE5K", 5000),
      taxAmountMinor: 3000,
      shippingAmountMinor: 2500,
      insuranceAmountMinor: 500,
    });

    expect(cart.computeAuthoritativeCheckoutBreakdown()).toEqual({
      subtotalMinor: 60000,
      discountMinor: 5000,
      taxMinor: 3000,
      shippingMinor: 2500,
      insuranceMinor: 500,
      totalMinor: 61000,
    });
  });

  it("applies a percentage discount in integer minor units (floor, no floats)", () => {
    // subtotal 60000, 10% (1000 bps) -> discount 6000 -> total 54000.
    const cart = buildCheckoutCart({
      id: "cart-1",
      promotion: buildPercentagePromotion("SAVE10", 1000),
      taxAmountMinor: 0,
      shippingAmountMinor: 0,
      insuranceAmountMinor: 0,
    });
    const breakdown = cart.computeAuthoritativeCheckoutBreakdown();
    expect(breakdown.discountMinor).toBe(6000);
    expect(breakdown.totalMinor).toBe(54000);
  });

  it("produces zero discount when no promotion is applied", () => {
    const cart = buildCheckoutCart({
      id: "cart-1",
      promotion: null,
      taxAmountMinor: 0,
      shippingAmountMinor: 0,
      insuranceAmountMinor: 0,
    });
    const breakdown = cart.computeAuthoritativeCheckoutBreakdown();
    expect(breakdown.discountMinor).toBe(0);
    expect(breakdown.totalMinor).toBe(breakdown.subtotalMinor);
  });

  it("reads the shipping component from the DURABLE selection, not a client value", () => {
    const cart = buildCheckoutCart({ id: "cart-1", shippingAmountMinor: 2500 });
    expect(cart.shippingAmountMinor).toBe(2500);
    expect(cart.computeAuthoritativeCheckoutBreakdown().shippingMinor).toBe(2500);
  });

  it("reads the insurance premium from the server-persisted amount", () => {
    const cart = buildCheckoutCart({ id: "cart-1", insuranceAmountMinor: 500 });
    expect(cart.computeAuthoritativeCheckoutBreakdown().insuranceMinor).toBe(500);
  });

  it("uses zero for unset tax, shipping, and insurance components", () => {
    const cart = buildCheckoutCart({ id: "cart-1" });
    const breakdown = cart.computeAuthoritativeCheckoutBreakdown();
    expect(breakdown.taxMinor).toBe(0);
    expect(breakdown.insuranceMinor).toBe(0);
    expect(breakdown.shippingMinor).toBe(2500); // the fixture always selects shipping
    expect(breakdown.totalMinor).toBe(
      breakdown.subtotalMinor - breakdown.discountMinor + breakdown.shippingMinor,
    );
  });
});

describe("Cart shipping selection invariants (payment precondition)", () => {
  it("a payment-ready cart has a complete, current, consistent selection", () => {
    const cart = buildCheckoutCart({ id: "cart-1" });
    expect(cart.hasShippingSelection).toBe(true);
    expect(cart.isShippingQuoteCurrent()).toBe(true);
    expect(cart.isShippingSelectionConsistent()).toBe(true);
  });

  it("a cart without shipping quotes is NOT payment-ready", () => {
    const cart = buildCheckoutCart({ id: "cart-1", shippingQuotes: [] });
    expect(cart.hasShippingSelection).toBe(false);
    expect(cart.isShippingSelectionConsistent()).toBe(false);
  });
});