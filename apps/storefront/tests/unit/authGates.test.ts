// apps/storefront/tests/unit/authGates.test.ts
//
// F8 Part 3 — identity-gating rules (src/lib/authGates.ts).
//
// Invariants under test:
//   - A KNOWN GUEST can never reach a state that mounts account data or
//     fires a protected order/account request (the gate says "signin").
//   - While identity resolution is IN FLIGHT nothing fires and nothing
//     navigates ("wait") — no protected request on an unresolved identity,
//     and no drawer/navigation that resolution could immediately contradict.
//   - Order-detail polling rules stay aligned: fulfilled/returned terminal,
//     on_hold deliberately NOT (regression guard for the G008 contract).

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  resolveAccountClick,
  resolveAccountDataGate,
} from "../../src/lib/authGates";
import { isOrderSettled } from "../../src/lib/orderPolling";

describe("resolveAccountDataGate — protected account data", () => {
  it("waits while identity resolution is in flight (no request)", () => {
    expect(resolveAccountDataGate("loading")).toBe("wait");
  });

  it("a known guest gets the sign-in state, NEVER account data", () => {
    expect(resolveAccountDataGate("guest")).toBe("signin");
  });

  it("an authenticated identity may mount its data sections", () => {
    expect(resolveAccountDataGate("authenticated")).toBe("ready");
  });

  it("an identity-resolution error retries IDENTITY first, not account data", () => {
    expect(resolveAccountDataGate("error")).toBe("identity-error");
  });

  it("no unresolved/transient state ever mounts protected data", () => {
    for (const status of ["loading", "guest", "error"] as const) {
      expect(resolveAccountDataGate(status)).not.toBe("ready");
    }
  });
});

describe("resolveAccountClick — header account button", () => {
  it("an authenticated customer navigates to /account", () => {
    expect(resolveAccountClick("authenticated")).toBe("navigate");
  });

  it("a known guest opens the auth drawer", () => {
    expect(resolveAccountClick("guest")).toBe("open-auth");
  });

  it("a transient identity error still offers sign-in (re-resolves)", () => {
    expect(resolveAccountClick("error")).toBe("open-auth");
  });

  it("an unresolved identity WAITS — no drawer, no navigation", () => {
    expect(resolveAccountClick("loading")).toBe("wait");
  });
});

describe("order polling terminality stays aligned (G008 regression)", () => {
  it("fulfilled/returned remain terminal; on_hold never is", () => {
    expect(isOrderSettled({ fulfillmentStatus: "fulfilled" })).toBe(true);
    expect(isOrderSettled({ fulfillmentStatus: "returned" })).toBe(true);
    expect(isOrderSettled({ fulfillmentStatus: "on_hold" })).toBe(false);
  });
});
