// apps/storefront/tests/unit/purchasePresentation.test.ts
//
// F9 / E4 — pure purchase presentation (src/lib/purchasePresentation.ts).
// Success is NEVER inferred: the order link exists only for the confirmed
// state AND a server-issued id; not_confirmed is never softened; timeout is
// neither success nor failure.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { presentPurchaseState } from "../../src/lib/purchasePresentation";

describe("presentPurchaseState — confirmed", () => {
  it("offers the receipt ONLY with a server-issued order id", () => {
    const withId = presentPurchaseState({
      state: "confirmed",
      reference: "ref-1",
      orderId: "ord-1",
    });
    expect(withId.receiptAvailable).toBe(true);
    expect(withId.badge).toBe("[ PAYMENT CONFIRMED ]");

    const withoutId = presentPurchaseState({
      state: "confirmed",
      reference: "ref-1",
      orderId: null,
    });
    expect(withoutId.receiptAvailable).toBe(false);
  });

  it("names the reference when the gateway sent one back", () => {
    const p = presentPurchaseState({
      state: "confirmed",
      reference: "ref-9",
      orderId: "ord-1",
    });
    expect(p.body.toLowerCase()).toContain("reference ref-9");
  });

  it("never offers recovery on confirmation", () => {
    const p = presentPurchaseState({
      state: "confirmed",
      reference: null,
      orderId: "ord-1",
    });
    expect(p.recoveryAction).toBe("none");
  });
});

describe("presentPurchaseState — non-success states stay honest", () => {
  it("timeout is neither success nor definitive failure, recovery = check again", () => {
    const p = presentPurchaseState({
      state: "timeout",
      reference: "ref-1",
      // Even a stray id cannot buy a receipt link in a non-confirmed state.
      orderId: "ord-1",
    });
    expect(p.receiptAvailable).toBe(false);
    expect(p.recoveryAction).toBe("check-again");
    expect(p.body.toLowerCase()).toContain("not a success or a failure");
  });

  it("not_confirmed claims nothing was paid and offers a clean restart", () => {
    const p = presentPurchaseState({
      state: "not_confirmed",
      reference: "ref-2",
      orderId: null,
    });
    expect(p.receiptAvailable).toBe(false);
    expect(p.recoveryAction).toBe("restart-checkout");
    expect(p.body.toLowerCase()).toContain("no completed payment recorded");
    expect(p.body).toContain("ref-2");
  });

  it("verifying claims nothing", () => {
    const p = presentPurchaseState({
      state: "verifying",
      reference: "ref-3",
      orderId: null,
    });
    expect(p.receiptAvailable).toBe(false);
    expect(p.recoveryAction).toBe("none");
    expect(p.headline.toLowerCase()).toContain("processing");
  });

  it("idle renders nothing at all", () => {
    const p = presentPurchaseState({
      state: "idle",
      reference: null,
      orderId: null,
    });
    expect(p.badge).toBe("");
    expect(p.headline).toBe("");
    expect(p.body).toBe("");
    expect(p.receiptAvailable).toBe(false);
  });

  it("blank/whitespace ids never count as server-issued", () => {
    const p = presentPurchaseState({
      state: "confirmed",
      reference: "ref-4",
      orderId: "   ",
    });
    expect(p.receiptAvailable).toBe(false);
  });
});
