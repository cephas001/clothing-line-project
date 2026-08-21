// apps/storefront/tests/unit/checkoutGate.test.ts
//
// F9 / E3 — pure checkout entry decisions (src/lib/checkoutGate.ts).
// Precedence is fixed and honest: loading → error → gateway return → empty →
// actionable. Payment readiness keeps BOTH server-backed preconditions.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  placeOrderReadiness,
  resolveCheckoutViewGate,
} from "../../src/lib/checkoutGate";

describe("resolveCheckoutViewGate — precedence", () => {
  it("cart loading wins over everything", () => {
    const gate = resolveCheckoutViewGate({
      cartStatus: "loading",
      lineCount: 0,
      gatewayReturnState: "confirmed",
    });
    expect(gate.kind).toBe("cart-loading");
  });

  it("cart error is recoverable, never rendered as an empty cart", () => {
    const gate = resolveCheckoutViewGate({
      cartStatus: "error",
      lineCount: 0,
      gatewayReturnState: "idle",
    });
    expect(gate.kind).toBe("cart-error");
  });

  it("a gateway return takes over even with ZERO lines (converted cart)", () => {
    const gate = resolveCheckoutViewGate({
      cartStatus: "ready",
      lineCount: 0,
      gatewayReturnState: "verifying",
    });
    expect(gate.kind).toBe("gateway-return");
  });

  it("an empty cart is its own honest state", () => {
    const gate = resolveCheckoutViewGate({
      cartStatus: "ready",
      lineCount: 0,
      gatewayReturnState: "idle",
    });
    expect(gate.kind).toBe("empty-cart");
  });

  it("an actionable cart requires lines and a loaded session", () => {
    const gate = resolveCheckoutViewGate({
      cartStatus: "ready",
      lineCount: 2,
      gatewayReturnState: "idle",
    });
    expect(gate.kind).toBe("actionable");
  });
});

describe("placeOrderReadiness — payment-entry guarantees", () => {
  it("requires BOTH the saved address and the frozen shipping option", () => {
    const ready = placeOrderReadiness({
      addressSaved: true,
      shippingSelected: true,
      syncing: false,
      initializingPayment: false,
    });
    expect(ready.canPlaceOrder).toBe(true);
    expect(ready.reason).toBeNull();
  });

  it("is never ready while a sync or payment init is in flight", () => {
    const syncing = placeOrderReadiness({
      addressSaved: true,
      shippingSelected: true,
      syncing: true,
      initializingPayment: false,
    });
    expect(syncing.canPlaceOrder).toBe(false);

    const initializing = placeOrderReadiness({
      addressSaved: true,
      shippingSelected: true,
      syncing: false,
      initializingPayment: true,
    });
    expect(initializing.canPlaceOrder).toBe(false);
  });

  it("names the missing precondition honestly", () => {
    const nothing = placeOrderReadiness({
      addressSaved: false,
      shippingSelected: false,
      syncing: false,
      initializingPayment: false,
    });
    expect(nothing.reason?.toLowerCase()).toContain("save your address");

    const noAddress = placeOrderReadiness({
      addressSaved: false,
      shippingSelected: true,
      syncing: false,
      initializingPayment: false,
    });
    expect(noAddress.reason?.toLowerCase()).toContain("address");

    const noShipping = placeOrderReadiness({
      addressSaved: true,
      shippingSelected: false,
      syncing: false,
      initializingPayment: false,
    });
    expect(noShipping.reason?.toLowerCase()).toContain("shipping");
  });

  it("never reports readiness without the server-frozen option", () => {
    const readiness = placeOrderReadiness({
      addressSaved: true,
      shippingSelected: false,
      syncing: false,
      initializingPayment: false,
    });
    expect(readiness.canPlaceOrder).toBe(false);
  });
});
