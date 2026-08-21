// apps/storefront/tests/integration/cartCheckoutApi.test.ts
//
// Cart mutations + checkout initialization over real HTTP. Financial-integrity
// assertions built in: the client NEVER sends totals/prices/tax/shipping to the
// server (they are server-computed), shipping selection sends ONLY a quoteId,
// and payment-sessions sends ONLY a returnUrl.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  addCartLineItem,
  applyCartDiscount,
  getCart,
  getShippingQuotes,
  initializeCartSession,
  initializePaymentSession,
  mergeGuestCart,
  removeCartLineItem,
  selectShippingOption,
  setCartShippingAddress,
  updateCartLineItemQuantity,
} from "../../src/lib/api/cart";
import { testServer } from "../helpers/testServer";
import {
  makeCart,
  makePaymentSession,
  makeQuote,
  makeShippingOptionSelected,
} from "../helpers/fixtures";
import { setToken, clearToken } from "../../src/lib/api/auth";

const CART_ID = "cart-000";

describe("cart service layer", () => {
  it("initializeCartSession posts only regionId + salesChannelId", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/carts", () => ({
      status: 200,
      body: makeCart({ id: CART_ID }),
    }));
    const cart = await initializeCartSession({
      regionId: "reg-test",
      salesChannelId: "channel-test",
    });
    expect(cart.id).toBe(CART_ID);
    expect(cart.status).toBe("active");
    const req = testServer.last();
    expect(req?.method).toBe("POST");
    expect(req?.body).toEqual({ regionId: "reg-test", salesChannelId: "channel-test" });
  });

  it("getCart parses the authoritative projection (server money intact)", async () => {
    await testServer.listen();
    testServer.clearReceived();
    const cart = makeCart({ id: CART_ID });
    testServer.when("GET", "/store/carts/cart-000", () => ({ status: 200, body: cart }));
    const result = await getCart(CART_ID);
    expect(result.cartTotalMinor).toBe(cart.cartTotalMinor);
    expect(result.taxAmountMinor).toBe(cart.taxAmountMinor);
    expect(result.items[0].unitPriceMinor).toBe(cart.items[0].unitPriceMinor);
  });

  it("addCartLineItem posts variantId + quantity and resolves on 204", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/carts/cart-000/line-items", () => ({ status: 204 }));
    const result = await addCartLineItem(CART_ID, { variantId: "var-1", quantity: 2 });
    expect(result).toBeUndefined();
    expect(testServer.last()?.body).toEqual({ variantId: "var-1", quantity: 2 });
  });

  it("updateCartLineItemQuantity PUTs to the line path with only a quantity", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("PUT", "/store/carts/cart-000/line-items/line-1", () => ({ status: 204 }));
    await updateCartLineItemQuantity(CART_ID, "line-1", { quantity: 3 });
    expect(testServer.last()?.path).toBe("/store/carts/cart-000/line-items/line-1");
    expect(testServer.last()?.body).toEqual({ quantity: 3 });
  });

  it("removeCartLineItem DELETEs the line path", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("DELETE", "/store/carts/cart-000/line-items/line-1", () => ({ status: 204 }));
    await removeCartLineItem(CART_ID, "line-1");
    expect(testServer.last()?.method).toBe("DELETE");
    expect(testServer.last()?.path).toBe("/store/carts/cart-000/line-items/line-1");
  });

  it("applyCartDiscount posts only the code", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/carts/cart-000/discount", () => ({ status: 204 }));
    await applyCartDiscount(CART_ID, { code: "WELCOME10" });
    expect(testServer.last()?.body).toEqual({ code: "WELCOME10" });
  });

  it("mergeGuestCart requires a bearer and posts guestCartId + customerId", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.test.token");
    testServer.when("POST", "/store/carts/cart-000/merge", () => ({ status: 204 }));
    await mergeGuestCart(CART_ID, { guestCartId: CART_ID, customerId: "cust-1" });
    expect(testServer.last()?.headers["authorization"]).toBe("Bearer jwt.test.token");
    expect(testServer.last()?.body).toEqual({ guestCartId: CART_ID, customerId: "cust-1" });
    clearToken();
  });

  it("setCartShippingAddress PUTs the address; the client never sends money", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("PUT", "/store/carts/cart-000/shipping-address", () => ({ status: 204 }));
    await setCartShippingAddress(CART_ID, {
      shippingAddress: {
        firstName: "Ada",
        lastName: "Lovelace",
        line1: "1 Test Street",
        city: "Lagos",
        state: "LA",
        postalCode: "100001",
        countryCode: "NG",
        isBusiness: false,
      },
    });
    const req = testServer.last();
    const sent = req?.body as { shippingAddress?: Record<string, unknown> };
    expect(sent?.shippingAddress?.city).toBe("Lagos");
    expect("amountMinor" in (sent?.shippingAddress ?? {})).toBe(false);
    expect("totalMinor" in (sent?.shippingAddress ?? {})).toBe(false);
  });

  it("getShippingQuotes parses the provider-neutral quote list", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/carts/cart-000/shipping-quotes", () => ({
      status: 200,
      body: [makeQuote({ id: "quote-1", amountMinor: 3000 })],
    }));
    const quotes = await getShippingQuotes(CART_ID);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].amountMinor).toBe(3000);
    expect(testServer.last()?.method).toBe("POST");
  });

  it("selectShippingOption posts ONLY a quoteId (no financial/provider fields)", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/carts/cart-000/shipping-options", () => ({
      status: 200,
      body: makeShippingOptionSelected({ quoteId: "quote-1", amountMinor: 3000 }),
    }));
    const selected = await selectShippingOption(CART_ID, { quoteId: "quote-1" });
    expect(selected.quoteId).toBe("quote-1");
    expect(selected.amountMinor).toBe(3000);
    expect(testServer.last()?.body).toEqual({ quoteId: "quote-1" });
  });

  it("initializePaymentSession posts ONLY a returnUrl and parses authorizationUrl + reference", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/carts/cart-000/payment-sessions", () => ({
      status: 200,
      body: makePaymentSession({ reference: "ref-000" }),
    }));
    const result = await initializePaymentSession(CART_ID, {
      returnUrl: "https://store.test/checkout",
    });
    expect(result.authorizationUrl).toBeTruthy();
    expect(result.reference).toBe("ref-000");
    expect(testServer.last()?.body).toEqual({ returnUrl: "https://store.test/checkout" });
  });
});