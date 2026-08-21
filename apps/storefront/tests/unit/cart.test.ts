// apps/storefront/tests/unit/cart.test.ts
//
// Cart session persistence + reconciliation vocabulary. The backend owns the
// cart; the storefront only persists the session id (single opaque uuid) and
// never prices anything client-side.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  clearCartId,
  isCartActionable,
  persistCartId,
  readCartId,
} from "../../src/lib/cart";
import { resetClientStorage } from "../helpers/env";

describe("cart session persistence (localStorage shim)", () => {
  it("persists and reads the session id", () => {
    resetClientStorage();
    expect(readCartId()).toBeNull();
    persistCartId("cart-123");
    expect(readCartId()).toBe("cart-123");
  });

  it("clearCartId removes the persisted id", () => {
    resetClientStorage();
    persistCartId("cart-123");
    clearCartId();
    expect(readCartId()).toBeNull();
  });

  it("persistCartId overwrites an existing session id", () => {
    resetClientStorage();
    persistCartId("cart-a");
    persistCartId("cart-b");
    expect(readCartId()).toBe("cart-b");
  });
});

describe("isCartActionable", () => {
  it("allows an active, non-frozen cart", () => {
    expect(isCartActionable({ status: "active", frozen: false })).toBe(true);
  });

  it("rejects a converted (terminal) cart", () => {
    expect(isCartActionable({ status: "converted", frozen: false })).toBe(false);
  });

  it("rejects a frozen cart", () => {
    expect(isCartActionable({ status: "active", frozen: true })).toBe(false);
  });
});