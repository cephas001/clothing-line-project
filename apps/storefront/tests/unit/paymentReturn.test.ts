// apps/storefront/tests/unit/paymentReturn.test.ts
//
// F6 Slice 2A — gateway-return classification (G003) and checkout identity
// rules (G004/G005), pure logic:
//
//   G003  a `?reference=` return is classified into confirmed / verifying /
//         timeout / not_confirmed from SERVER-authoritative signals only.
//         A cancelled return (no live charge: paymentStatus "pending") is
//         NEVER "still confirming"; a timeout is never success or definitive
//         failure; no state fabricates an order id or a payment outcome.
//   G004  an order link is offered only when authenticated AND the server
//         projection carried the orderId.
//   G005  the sign-in affordance shows only for guests.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  MAX_PAYMENT_VERIFY_ATTEMPTS,
  canLinkOrderToAccount,
  classifyGatewayReturn,
  showGuestSignInAffordance,
} from "../../src/lib/paymentReturn";

function classify(overrides: {
  hasReference?: boolean;
  reference?: string | null;
  receiptReference?: string | null;
  serverConfirmed?: boolean;
  paymentStatus?: "pending" | "initialized" | "paid" | null;
  attempts?: number;
  maxAttempts?: number;
}) {
  return classifyGatewayReturn({
    hasReference: true,
    serverConfirmed: false,
    paymentStatus: "initialized",
    attempts: 0,
    maxAttempts: MAX_PAYMENT_VERIFY_ATTEMPTS,
    ...overrides,
  });
}

describe("classifyGatewayReturn — idle", () => {
  it("a normal checkout visit without ?reference= is IDLE", () => {
    expect(classify({ hasReference: false })).toBe("idle");
  });

  it("idle even when a stale projection still shows initialized", () => {
    expect(
      classify({ hasReference: false, paymentStatus: "initialized", attempts: 99 }),
    ).toBe("idle");
  });
});

describe("classifyGatewayReturn — confirmed (server-authoritative)", () => {
  it("confirmation wins at any attempt count and any reported status", () => {
    expect(classify({ serverConfirmed: true, paymentStatus: "initialized" })).toBe("confirmed");
    expect(classify({ serverConfirmed: true, paymentStatus: "pending", attempts: 50 })).toBe("confirmed");
  });

  it("is confirmed while the window is still open, too", () => {
    expect(classify({ serverConfirmed: true, attempts: 1 })).toBe("confirmed");
  });
});

describe("classifyGatewayReturn — cancelled / not confirmed (G003)", () => {
  it("paymentStatus 'pending' means NO live charge → not_confirmed immediately", () => {
    expect(classify({ paymentStatus: "pending", attempts: 0 })).toBe("not_confirmed");
  });

  it("not_confirmed even mid-window — waiting cannot change it", () => {
    expect(classify({ paymentStatus: "pending", attempts: 5 })).toBe("not_confirmed");
  });

  it("not_confirmed is distinct from timeout and confirmed", () => {
    const states = new Set([
      classify({ paymentStatus: "pending" }),
      classify({ paymentStatus: "initialized", attempts: MAX_PAYMENT_VERIFY_ATTEMPTS }),
      classify({ serverConfirmed: true }),
    ]);
    expect(states.size).toBe(3);
  });
});

describe("classifyGatewayReturn — pending/processing vs timed out", () => {
  it("a live obligation inside the window is VERIFYING (nothing claimed)", () => {
    expect(classify({ paymentStatus: "initialized", attempts: 0 })).toBe("verifying");
    expect(
      classify({ paymentStatus: "initialized", attempts: MAX_PAYMENT_VERIFY_ATTEMPTS - 1 }),
    ).toBe("verifying");
  });

  it("an unreadable projection (null) keeps verifying until the window closes", () => {
    expect(classify({ paymentStatus: null, attempts: 3 })).toBe("verifying");
    expect(classify({ paymentStatus: null, attempts: MAX_PAYMENT_VERIFY_ATTEMPTS })).toBe("timeout");
  });

  it("the window boundary flips verifying → timeout exactly at maxAttempts", () => {
    expect(classify({ attempts: MAX_PAYMENT_VERIFY_ATTEMPTS - 1 })).toBe("verifying");
    expect(classify({ attempts: MAX_PAYMENT_VERIFY_ATTEMPTS })).toBe("timeout");
    expect(classify({ attempts: MAX_PAYMENT_VERIFY_ATTEMPTS + 10 })).toBe("timeout");
  });

  it("timeout requires a LIVE obligation; a dead one is not_confirmed instead", () => {
    expect(classify({ paymentStatus: "initialized", attempts: 100 })).toBe("timeout");
    expect(classify({ paymentStatus: "pending", attempts: 100 })).toBe("not_confirmed");
  });
});

describe("canLinkOrderToAccount (G004)", () => {
  it("links only for an authenticated viewer WITH a server order id", () => {
    expect(canLinkOrderToAccount(true, "order-123")).toBe(true);
  });

  it("never links for guests — even when an orderId exists", () => {
    expect(canLinkOrderToAccount(false, "order-123")).toBe(false);
  });

  it("never links without a server-issued orderId", () => {
    expect(canLinkOrderToAccount(true, null)).toBe(false);
    expect(canLinkOrderToAccount(true, undefined)).toBe(false);
    expect(canLinkOrderToAccount(true, "")).toBe(false);
  });
});

describe("showGuestSignInAffordance (G005)", () => {
  it("shows ONLY for guests", () => {
    expect(showGuestSignInAffordance("guest")).toBe(true);
  });

  it("never nags authenticated users or unknown/loading states", () => {
    expect(showGuestSignInAffordance("authenticated")).toBe(false);
    expect(showGuestSignInAffordance("loading")).toBe(false);
    expect(showGuestSignInAffordance("error")).toBe(false);
  });
});

describe("classifyGatewayReturn — persisted-receipt precedence (F6.6-G001)", () => {
  it("a receipt whose reference EXACTLY matches the return confirms it, even on a fresh pending cart", () => {
    // Post-confirmation reload: the live cart was replaced by a fresh session
    // reporting "pending", but the validated receipt proves THIS reference.
    expect(
      classify({
        reference: "ref-X",
        receiptReference: "ref-X",
        paymentStatus: "pending",
        attempts: 0,
      }),
    ).toBe("confirmed");
  });

  it("the matched-receipt confirmation outranks even a closed window", () => {
    expect(
      classify({
        reference: "ref-X",
        receiptReference: "ref-X",
        paymentStatus: "initialized",
        attempts: MAX_PAYMENT_VERIFY_ATTEMPTS + 5,
      }),
    ).toBe("confirmed");
  });

  it("server confirmation still wins before the receipt path is consulted", () => {
    expect(
      classify({
        reference: "ref-X",
        receiptReference: "other-ref",
        serverConfirmed: true,
        paymentStatus: "paid",
      }),
    ).toBe("confirmed");
  });

  it("a receipt for a DIFFERENT reference never confirms — pending stays not_confirmed", () => {
    expect(
      classify({
        reference: "ref-Y",
        receiptReference: "ref-X",
        paymentStatus: "pending",
        attempts: 0,
      }),
    ).toBe("not_confirmed");
  });

  it("an absent/malformed receipt (null after validation) never confirms", () => {
    expect(
      classify({
        reference: "ref-X",
        receiptReference: null,
        paymentStatus: "pending",
        attempts: 0,
      }),
    ).toBe("not_confirmed");
    expect(
      classify({
        reference: "ref-X",
        receiptReference: undefined,
        paymentStatus: "pending",
      }),
    ).toBe("not_confirmed");
  });

  it("empty-string references are not proof on either side", () => {
    expect(
      classify({
        reference: "",
        receiptReference: "",
        paymentStatus: "pending",
      }),
    ).toBe("not_confirmed");
    expect(
      classify({
        reference: "ref-X",
        receiptReference: "",
        paymentStatus: "initialized",
        attempts: MAX_PAYMENT_VERIFY_ATTEMPTS,
      }),
    ).toBe("timeout");
  });

  it("without a URL reference the classifier stays idle regardless of receipts", () => {
    expect(
      classify({
        hasReference: false,
        reference: null,
        receiptReference: "ref-X",
        serverConfirmed: false,
        paymentStatus: "paid",
      }),
    ).toBe("idle");
  });
});
