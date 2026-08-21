// apps/storefront/tests/unit/orderPolling.test.ts
//
// Slice 2B — G008 refresh rules (stop at terminal state) and the G009
// authentication gate ordering (identity resolved BEFORE any protected fetch).

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  ORDER_POLL_INTERVAL_MS,
  isOrderSettled,
  shouldPollOrder,
} from "../../src/lib/orderPolling";
import { resolveOrderFetchGate } from "../../src/lib/orderAccess";
import { makeOrder } from "../helpers/fixtures";

describe("isOrderSettled — terminal fulfillment states (G008)", () => {
  it("fulfilled and returned are terminal", () => {
    expect(isOrderSettled({ fulfillmentStatus: "fulfilled" })).toBe(true);
    expect(isOrderSettled({ fulfillmentStatus: "returned" })).toBe(true);
  });

  it("every mutable lifecycle state keeps refreshing", () => {
    expect(isOrderSettled({ fulfillmentStatus: "unfulfilled" })).toBe(false);
    expect(isOrderSettled({ fulfillmentStatus: "ready_for_dispatch" })).toBe(false);
    expect(isOrderSettled({ fulfillmentStatus: "partially_fulfilled" })).toBe(false);
    // on_hold can resume — deliberately NOT terminal.
    expect(isOrderSettled({ fulfillmentStatus: "on_hold" })).toBe(false);
  });
});

describe("shouldPollOrder", () => {
  it("polls a mutable order and stops at a terminal one", () => {
    expect(shouldPollOrder(makeOrder({ fulfillmentStatus: "partially_fulfilled" }))).toBe(true);
    expect(shouldPollOrder(makeOrder({ fulfillmentStatus: "fulfilled" }))).toBe(false);
    expect(shouldPollOrder(makeOrder({ fulfillmentStatus: "returned" }))).toBe(false);
  });

  it("never polls without an order projection", () => {
    expect(shouldPollOrder(null)).toBe(false);
  });

  it("payment state alone does not stop polling (shipping still progresses)", () => {
    // A captured payment precedes shipping activity worth refreshing.
    expect(shouldPollOrder(makeOrder({ paymentStatus: "captured", fulfillmentStatus: "unfulfilled" }))).toBe(true);
  });

  it("uses a slow, polite interval", () => {
    expect(ORDER_POLL_INTERVAL_MS).toBe(15_000);
  });
});

describe("resolveOrderFetchGate — G009 ordering", () => {
  it("waits while identity resolution is in flight (no protected request)", () => {
    expect(resolveOrderFetchGate("loading")).toBe("wait");
  });

  it("a known guest gets the sign-in state, NEVER a protected fetch", () => {
    expect(resolveOrderFetchGate("guest")).toBe("signin");
  });

  it("an authenticated identity may fetch", () => {
    expect(resolveOrderFetchGate("authenticated")).toBe("fetch");
  });

  it("an identity error still allows the authoritative request to decide", () => {
    expect(resolveOrderFetchGate("error")).toBe("fetch");
  });
});
