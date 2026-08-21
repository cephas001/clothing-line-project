// apps/storefront/tests/integration/cartSessionRecovery.test.ts
//
// F6 Slice 1 — cart session recovery over REAL HTTP (no fetch mocks). The
// injected CartSessionApi is wired to the REAL client functions exactly as
// CartContext does, and pointed at the in-process node:http server:
//
//   G001  a persisted cart id that 404s is stale → POST /store/carts creates
//         a fresh session and the new id is persisted. A 500 NEVER becomes an
//         empty cart — it surfaces and no cart is created.
//   G002  a persisted terminal (converted) cart is replaced by a fresh
//         session; the terminal cart is never mutated.
//   Queue safety  a mutation that 404s mid-flight is retried ONCE against a
//         freshly-created session, whose id is persisted for follow-ups.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import type { CartSessionApi } from "../../src/lib/cartSession";
import { mutateOnActionableSession, resolveActionableSession } from "../../src/lib/cartSession";
import {
  addCartLineItem,
  getCart,
  initializeCartSession,
} from "../../src/lib/api/cart";
import { testServer } from "../helpers/testServer";
import { makeCart } from "../helpers/fixtures";
import { resetClientStorage } from "../helpers/env";

/**
 * The REAL wiring (mirrors CartContext's cartSessionApi): real client
 * functions, real HTTP, real localStorage shim for id persistence.
 * `initialId` seeds the persisted session id (what a returning browser
 * session would find in localStorage).
 */
function realCartSessionApi(initialId: string | null): CartSessionApi & {
  persistedLog: string[];
} {
  let persistedId = initialId;
  const persistedLog: string[] = [];
  return {
    persistedLog,
    async getCart(id: string) {
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
    persistId(id: string) {
      persistedId = id;
      persistedLog.push(id);
    },
    isActionable(cart) {
      return cart.status === "active" && !cart.frozen;
    },
  };
}

function notFoundEnvelope() {
  return {
    status: 404,
    body: {
      success: false,
      error: { code: "RESOURCE_NOT_FOUND", message: "Cart not found." },
    },
  };
}

describe("cart session recovery over real HTTP (G001)", () => {
  it("a stale persisted id (404) is discarded; a fresh cart is created and its id persisted", async () => {
    await testServer.listen();
    resetClientStorage();
    testServer.clearReceived();

    let created = 0;
    testServer.when("GET", "/store/carts/cart-stale", () => notFoundEnvelope());
    testServer.when("POST", "/store/carts", () => {
      created += 1;
      return { status: 200, body: makeCart({ id: `cart-new-${created}` }) };
    });

    const api = realCartSessionApi("cart-stale");
    const resolution = await resolveActionableSession(api, null);

    // The old id was probed and rejected; exactly one fresh cart was created.
    expect(api.persistedLog).toEqual(["cart-new-1"]);
    expect(resolution.fresh).toBe(true);
    expect(resolution.cart.id).toBe("cart-new-1");

    const posts = testServer.received.filter(
      (r) => r.method === "POST" && r.path === "/store/carts",
    );
    expect(posts).toHaveLength(1);
    // Creation sends ONLY region/channel context — never money.
    expect(posts[0].body).toEqual({
      regionId: "reg-test",
      salesChannelId: "channel-test",
    });
  });

  it("a 500 while restoring surfaces — NO fresh cart is created (never an empty cart)", async () => {
    await testServer.listen();
    resetClientStorage();
    testServer.clearReceived();

    testServer.when("GET", "/store/carts/cart-live", () => ({
      status: 500,
      body: {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Database unavailable." },
      },
    }));

    const api = realCartSessionApi("cart-live");
    await expect(
      async () => resolveActionableSession(api, null),
    ).rejectsWithCode("INTERNAL_ERROR");

    const creations = testServer.received.filter(
      (r) => r.method === "POST" && r.path === "/store/carts",
    );
    expect(creations).toHaveLength(0);
    expect(api.persistedLog).toEqual([]);
  });

  it("an actionable persisted cart is restored as-is (no creation round-trip)", async () => {
    await testServer.listen();
    resetClientStorage();
    testServer.clearReceived();

    const existing = makeCart({ id: "cart-live", status: "active" });
    testServer.when("GET", "/store/carts/cart-live", () => ({
      status: 200,
      body: existing,
    }));

    const api = realCartSessionApi("cart-live");
    const resolution = await resolveActionableSession(api, null);

    expect(resolution.fresh).toBe(false);
    expect(resolution.cart.cartTotalMinor).toBe(existing.cartTotalMinor);
    const creations = testServer.received.filter(
      (r) => r.method === "POST" && r.path === "/store/carts",
    );
    expect(creations).toHaveLength(0);
    expect(api.persistedLog).toEqual([]);
  });
});

describe("terminal cart recovery over real HTTP (G002)", () => {
  it("a persisted CONVERTED cart is replaced by a fresh session — never mutated", async () => {
    await testServer.listen();
    resetClientStorage();
    testServer.clearReceived();

    const terminal = makeCart({ id: "cart-converted", status: "converted" });
    testServer.when("GET", "/store/carts/cart-converted", () => ({
      status: 200,
      body: terminal,
    }));
    testServer.when("POST", "/store/carts", () => ({
      status: 200,
      body: makeCart({ id: "cart-fresh" }),
    }));

    const api = realCartSessionApi("cart-converted");
    const resolution = await resolveActionableSession(api, null);

    expect(resolution.fresh).toBe(true);
    expect(resolution.cart.id).toBe("cart-fresh");
    expect(api.persistedLog).toEqual(["cart-fresh"]);

    // The ONLY writes went to cart creation — the terminal cart was touched
    // by nothing but the restore read.
    const mutations = testServer.received.filter(
      (r) =>
        r.method !== "GET" &&
        r.path !== "/store/carts" &&
        r.path.startsWith("/store/carts/"),
    );
    expect(mutations).toHaveLength(0);
  });
});

describe("mutation retry-once over real HTTP (queue safety)", () => {
  it("a mutation that 404s on the dead session is retried ONCE against a fresh cart", async () => {
    await testServer.listen();
    resetClientStorage();
    testServer.clearReceived();

    const current = makeCart({ id: "cart-old", status: "active" });
    testServer.when("POST", "/store/carts/cart-old/line-items", () =>
      notFoundEnvelope(),
    );
    testServer.when("POST", "/store/carts/cart-new/line-items", () => ({
      status: 204,
    }));
    testServer.when("POST", "/store/carts", () => ({
      status: 200,
      body: makeCart({ id: "cart-new" }),
    }));

    const api = realCartSessionApi(null);
    const outcome = await mutateOnActionableSession({
      api,
      current,
      mutate: (cartId) => addCartLineItem(cartId, { variantId: "var-1", quantity: 1 }),
    });

    expect(outcome.fresh).toBe(true);
    expect(outcome.cart.id).toBe("cart-new");
    expect(api.persistedLog).toEqual(["cart-new"]);

    // Exactly one replacement creation; the add hit old then new, in order.
    const creations = testServer.received.filter(
      (r) => r.method === "POST" && r.path === "/store/carts",
    );
    expect(creations).toHaveLength(1);

    const adds = testServer.received.filter(
      (r) => r.method === "POST" && r.path.endsWith("/line-items"),
    );
    expect(adds).toHaveLength(2);
    expect(adds[0].path).toBe("/store/carts/cart-old/line-items");
    expect(adds[1].path).toBe("/store/carts/cart-new/line-items");
    // The retried add carries the SAME payload — no stale state leaked.
    expect(adds[1].body).toEqual({ variantId: "var-1", quantity: 1 });
  });

  it("a NON-404 mutation failure propagates without creating any replacement", async () => {
    await testServer.listen();
    resetClientStorage();
    testServer.clearReceived();

    const current = makeCart({ id: "cart-old", status: "active" });
    testServer.when("POST", "/store/carts/cart-old/line-items", () => ({
      status: 409,
      body: {
        success: false,
        error: { code: "OUT_OF_STOCK", message: "Variant is out of stock." },
      },
    }));

    const api = realCartSessionApi(null);
    await expect(
      async () =>
        mutateOnActionableSession({
          api,
          current,
          mutate: (cartId) =>
            addCartLineItem(cartId, { variantId: "var-1", quantity: 1 }),
        }),
    ).rejectsWithCode("OUT_OF_STOCK");

    const creations = testServer.received.filter(
      (r) => r.method === "POST" && r.path === "/store/carts",
    );
    expect(creations).toHaveLength(0);
    expect(api.persistedLog).toEqual([]);
  });
});
