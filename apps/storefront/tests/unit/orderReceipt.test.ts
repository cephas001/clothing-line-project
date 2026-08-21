// apps/storefront/tests/unit/orderReceipt.test.ts
//
// F6 Slice 2A — post-purchase persistence (G004) and the pending-payment
// record that keeps gateway-return verification pointed at the exact cart the
// attempt was initialized against (robust against Slice 1 session recovery).
// localStorage holds NO money values — ids, references, and timestamps only.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  clearOrderReceipt,
  clearPendingPayment,
  persistOrderReceipt,
  persistPendingPayment,
  readLastOrderReceipt,
  readPendingPayment,
} from "../../src/lib/orderReceipt";
import { resetClientStorage } from "../helpers/env";

describe("order receipt persistence (G004)", () => {
  it("round-trips a confirmed order receipt", () => {
    resetClientStorage();
    expect(readLastOrderReceipt()).toBeNull();
    persistOrderReceipt({
      orderId: "order-001",
      reference: "ref-001",
      confirmedAt: "2026-01-01T00:00:00.000Z",
    });
    const receipt = readLastOrderReceipt();
    expect(receipt).toBeDefined();
    expect(receipt?.orderId).toBe("order-001");
    expect(receipt?.reference).toBe("ref-001");
  });

  it("keeps the most recent confirmation (persistent path to the latest order)", () => {
    resetClientStorage();
    persistOrderReceipt({
      orderId: "order-001",
      reference: "ref-001",
      confirmedAt: "2026-01-01T00:00:00.000Z",
    });
    persistOrderReceipt({
      orderId: "order-002",
      reference: "ref-002",
      confirmedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(readLastOrderReceipt()?.orderId).toBe("order-002");
  });

  it("rejects a corrupt receipt instead of crashing the UI", () => {
    resetClientStorage();
    window.localStorage.setItem("QUHA-order-receipt", "{not json");
    expect(readLastOrderReceipt()).toBeNull();
    window.localStorage.setItem(
      "QUHA-order-receipt",
      JSON.stringify({ wrong: "shape" }),
    );
    expect(readLastOrderReceipt()).toBeNull();
  });

  it("clearOrderReceipt removes the persistent path", () => {
    resetClientStorage();
    persistOrderReceipt({
      orderId: "order-001",
      reference: null,
      confirmedAt: "2026-01-01T00:00:00.000Z",
    });
    clearOrderReceipt();
    expect(readLastOrderReceipt()).toBeNull();
  });
});

describe("pending payment record (verification continuity)", () => {
  it("round-trips the attempt's cart + reference", () => {
    resetClientStorage();
    expect(readPendingPayment()).toBeNull();
    persistPendingPayment({
      cartId: "cart-001",
      reference: "ref-001",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const pending = readPendingPayment();
    expect(pending).toBeDefined();
    expect(pending?.cartId).toBe("cart-001");
    expect(pending?.reference).toBe("ref-001");
  });

  it("a new attempt overwrites the previous record", () => {
    resetClientStorage();
    persistPendingPayment({ cartId: "cart-old", reference: "ref-old", startedAt: "x" });
    persistPendingPayment({ cartId: "cart-new", reference: "ref-new", startedAt: "y" });
    expect(readPendingPayment()?.cartId).toBe("cart-new");
  });

  it("rejects corrupt records", () => {
    resetClientStorage();
    window.localStorage.setItem("QUHA-pending-payment", "42");
    expect(readPendingPayment()).toBeNull();
    window.localStorage.setItem(
      "QUHA-pending-payment",
      JSON.stringify({ cartId: "", reference: "ref", startedAt: "t" }),
    );
    expect(readPendingPayment()).toBeNull();
  });

  it("clearPendingPayment removes the record", () => {
    resetClientStorage();
    persistPendingPayment({ cartId: "cart-001", reference: "ref-001", startedAt: "x" });
    clearPendingPayment();
    expect(readPendingPayment()).toBeNull();
  });
});
