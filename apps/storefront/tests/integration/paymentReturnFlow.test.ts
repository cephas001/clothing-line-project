// apps/storefront/tests/integration/paymentReturnFlow.test.ts
//
// F6 Slice 2A — gateway-return verification over REAL HTTP (no fetch mocks).
// The authoritative Cart projection is fetched through the REAL client from
// the in-process server and fed into the G003 classifier exactly as
// CheckoutView does:
//
//   - paid/converted/orderId  → confirmed (server-authoritative; the frontend
//     invents no payment state of its own)
//   - active + initialized    → verifying inside the window / timeout after it
//   - active + pending        → not_confirmed (cancelled: no live charge)
//
// Also covered: the pending-payment record matching rule that keeps
// verification pointed at the exact cart the attempt was initialized against.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { getCart, initializeCartSession } from "../../src/lib/api/cart";
import {
  MAX_PAYMENT_VERIFY_ATTEMPTS,
  classifyGatewayReturn,
} from "../../src/lib/paymentReturn";
import {
  clearPendingPayment,
  persistOrderReceipt,
  persistPendingPayment,
  readLastOrderReceipt,
  readPendingPayment,
} from "../../src/lib/orderReceipt";
import { resolveActionableSession } from "../../src/lib/cartSession";
import type { CartSessionApi } from "../../src/lib/cartSession";
import { makeCart } from "../helpers/fixtures";
import { resetClientStorage } from "../helpers/env";
import { testServer } from "../helpers/testServer";

/** The CheckoutView classification step, fed by a real projection. */
async function classifyLiveReturn(options: {
  cartId: string;
  reference: string;
  attempts: number;
  receiptReference?: string | null;
}) {
  const projection = await getCart(options.cartId);
  const serverConfirmed =
    projection.paymentStatus === "paid" ||
    projection.status === "converted" ||
    !!projection.orderId;
  return classifyGatewayReturn({
    hasReference: true,
    reference: options.reference,
    receiptReference: options.receiptReference ?? null,
    serverConfirmed,
    paymentStatus: projection.paymentStatus ?? null,
    attempts: options.attempts,
    maxAttempts: MAX_PAYMENT_VERIFY_ATTEMPTS,
  });
}

describe("gateway return over real HTTP (G003)", () => {
  it("a PAID + converted projection classifies as confirmed", async () => {
    await testServer.listen();
    const confirmed = makeCart({
      id: "cart-paid",
      status: "converted",
      orderId: "order-777",
    });
    // makeCart types carry optional fields; force the authoritative values.
    const paidCart = { ...confirmed, paymentStatus: "paid" as const };
    testServer.when("GET", "/store/carts/cart-paid", () => ({
      status: 200,
      body: paidCart,
    }));

    const state = await classifyLiveReturn({
      cartId: "cart-paid",
      reference: "ref-1",
      attempts: 0,
    });
    expect(state).toBe("confirmed");
  });

  it("a live obligation (initialized) verifies inside the window, times out after it", async () => {
    await testServer.listen();
    const live = { ...makeCart({ id: "cart-live" }), paymentStatus: "initialized" as const };
    testServer.when("GET", "/store/carts/cart-live", () => ({
      status: 200,
      body: live,
    }));

    const midWindow = await classifyLiveReturn({
      cartId: "cart-live",
      reference: "ref-1",
      attempts: 3,
    });
    expect(midWindow).toBe("verifying");

    const afterWindow = await classifyLiveReturn({
      cartId: "cart-live",
      reference: "ref-1",
      attempts: MAX_PAYMENT_VERIFY_ATTEMPTS,
    });
    expect(afterWindow).toBe("timeout");
  });

  it("no live charge (pending) is NOT CONFIRMED — never 'still confirming'", async () => {
    await testServer.listen();
    const dead = { ...makeCart({ id: "cart-dead" }), paymentStatus: "pending" as const };
    testServer.when("GET", "/store/carts/cart-dead", () => ({
      status: 200,
      body: dead,
    }));

    const state = await classifyLiveReturn({
      cartId: "cart-dead",
      reference: "ref-1",
      attempts: 0,
    });
    expect(state).toBe("not_confirmed");
  });

  it("an orderId alone confirms even before status flips to converted", async () => {
    await testServer.listen();
    const converting = makeCart({ id: "cart-converting", orderId: "order-999" });
    testServer.when("GET", "/store/carts/cart-converting", () => ({
      status: 200,
      body: converting,
    }));
    const state = await classifyLiveReturn({
      cartId: "cart-converting",
      reference: "ref-1",
      attempts: 7,
    });
    expect(state).toBe("confirmed");
  });
});

describe("pending-payment record matching (verification continuity)", () => {
  it("records the attempt's cart + reference before the redirect", () => {
    resetClientStorage();
    persistPendingPayment({
      cartId: "cart-attempt",
      reference: "gw-ref-42",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const pending = readPendingPayment();
    expect(pending?.cartId).toBe("cart-attempt");
    // The return leg matches on the URL's ?reference= value.
    expect(pending?.reference === "gw-ref-42").toBe(true);
    expect(pending?.reference === "other-ref").toBe(false);
  });
});

/**
 * F6.6-G001 — duplicate gateway return AFTER confirmation.
 *
 * Failure sequence being regression-proofed: payment confirms → receipt is
 * persisted → pending record cleared → session recovery replaces the
 * converted cart with a fresh "pending" one → the SAME ?reference=X is
 * loaded again. Before the fix the fresh cart's "pending" misclassified this
 * as not_confirmed; the validated receipt must prove confirmation instead.
 */
describe("duplicate gateway return after confirmation (F6.6-G001)", () => {
  /** Real client wiring for the boot-time session replacement step. */
  function realSessionApi(initialId: string | null): CartSessionApi {
    let persistedId = initialId;
    return {
      async getCart(id) {
        return getCart(id);
      },
      async createCart() {
        return initializeCartSession({
          regionId: "reg-test",
          salesChannelId: "channel-test",
        });
      },
      readPersistedId() {
        return persistedId;
      },
      persistId(id) {
        persistedId = id;
      },
      isActionable(cart) {
        return cart.status === "active" && !cart.frozen;
      },
    };
  }

  it("confirmed → receipt persisted → pending cleared → cart replaced → same ?reference= is CONFIRMED", async () => {
    await testServer.listen();
    resetClientStorage();
    testServer.clearReceived();

    const confirmedCart = {
      ...makeCart({ id: "cart-attempt", status: "converted", orderId: "order-777" }),
      paymentStatus: "paid" as const,
    };
    const freshCart = { ...makeCart({ id: "cart-fresh" }), paymentStatus: "pending" as const };
    testServer.when("GET", "/store/carts/cart-attempt", () => ({
      status: 200,
      body: confirmedCart,
    }));
    testServer.when("GET", "/store/carts/cart-fresh", () => ({
      status: 200,
      body: freshCart,
    }));
    testServer.when("POST", "/store/carts", () => ({
      status: 200,
      body: freshCart,
    }));

    // 1. The attempt is recorded BEFORE the gateway redirect.
    persistPendingPayment({
      cartId: "cart-attempt",
      reference: "ref-X",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    // 2. First return leg: the server projection itself proves confirmation.
    const firstVisit = await classifyLiveReturn({
      cartId: "cart-attempt",
      reference: "ref-X",
      attempts: 0,
    });
    expect(firstVisit).toBe("confirmed");

    // 3. Confirmation side effects: receipt persisted, pending record cleared.
    persistOrderReceipt({
      orderId: "order-777",
      reference: "ref-X",
      confirmedAt: "2026-01-01T00:01:00.000Z",
    });
    clearPendingPayment();
    expect(readPendingPayment()).toBe(null);

    // 4. Next boot: session recovery replaces the converted cart with a fresh
    //    "pending" session (real HTTP), exactly as G002 dictates.
    const api = realSessionApi("cart-attempt");
    const resolution = await resolveActionableSession(api, null);
    expect(resolution.fresh).toBe(true);
    expect(resolution.cart.id).toBe("cart-fresh");
    expect(resolution.cart.paymentStatus).toBe("pending");

    // 5. The SAME ?reference=X is loaded again against the fresh cart. The
    //    validated persisted receipt — not the live projection — proves it.
    const reload = await classifyLiveReturn({
      cartId: resolution.cart.id,
      reference: "ref-X",
      attempts: 0,
      receiptReference: readLastOrderReceipt()?.reference ?? null,
    });
    expect(reload).toBe("confirmed");
  });

  it("a DIFFERENT ?reference= against the same state is NOT confirmed", async () => {
    await testServer.listen();
    resetClientStorage();

    const fresh = { ...makeCart({ id: "cart-fresh" }), paymentStatus: "pending" as const };
    testServer.when("GET", "/store/carts/cart-fresh", () => ({
      status: 200,
      body: fresh,
    }));
    persistOrderReceipt({
      orderId: "order-777",
      reference: "ref-X",
      confirmedAt: "2026-01-01T00:01:00.000Z",
    });

    const state = await classifyLiveReturn({
      cartId: "cart-fresh",
      reference: "ref-Y",
      attempts: 0,
      receiptReference: readLastOrderReceipt()?.reference ?? null,
    });
    expect(state).toBe("not_confirmed");
  });

  it("a MALFORMED persisted receipt (unparseable JSON) never confirms", async () => {
    await testServer.listen();
    resetClientStorage();

    const fresh = { ...makeCart({ id: "cart-fresh" }), paymentStatus: "pending" as const };
    testServer.when("GET", "/store/carts/cart-fresh", () => ({
      status: 200,
      body: fresh,
    }));
    window.localStorage.setItem("QUHA-order-receipt", "{not valid json");
    expect(readLastOrderReceipt()).toBe(null);

    const state = await classifyLiveReturn({
      cartId: "cart-fresh",
      reference: "ref-X",
      attempts: 0,
      receiptReference: readLastOrderReceipt()?.reference ?? null,
    });
    expect(state).toBe("not_confirmed");
  });

  it("a WRONG-SHAPED receipt (valid JSON, invalid record) never confirms", async () => {
    await testServer.listen();
    resetClientStorage();

    const fresh = { ...makeCart({ id: "cart-fresh" }), paymentStatus: "pending" as const };
    testServer.when("GET", "/store/carts/cart-fresh", () => ({
      status: 200,
      body: fresh,
    }));
    window.localStorage.setItem(
      "QUHA-order-receipt",
      JSON.stringify({ hello: "world" }),
    );
    expect(readLastOrderReceipt()).toBe(null);

    const state = await classifyLiveReturn({
      cartId: "cart-fresh",
      reference: "ref-X",
      attempts: 0,
      receiptReference: readLastOrderReceipt()?.reference ?? null,
    });
    expect(state).toBe("not_confirmed");
  });

  it("no receipt at all + a fresh pending cart → not_confirmed (unchanged rule)", async () => {
    await testServer.listen();
    resetClientStorage();

    const fresh = { ...makeCart({ id: "cart-fresh" }), paymentStatus: "pending" as const };
    testServer.when("GET", "/store/carts/cart-fresh", () => ({
      status: 200,
      body: fresh,
    }));

    const state = await classifyLiveReturn({
      cartId: "cart-fresh",
      reference: "ref-X",
      attempts: 0,
      receiptReference: readLastOrderReceipt()?.reference ?? null,
    });
    expect(state).toBe("not_confirmed");
  });
});
