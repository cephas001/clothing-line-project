// apps/storefront/tests/unit/receiptRows.test.ts
//
// F9 / E6 — pure order-receipt rows (src/lib/receiptRows.ts).
// Every amount is the SERVER value verbatim; the module decides rows and
// labels only. No addition, subtraction, or total derivation exists here.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { makeOrder } from "../helpers/fixtures";
import {
  lineFulfillmentLabel,
  receiptSummaryRows,
  receiptTotalRow,
} from "../../src/lib/receiptRows";

describe("receiptSummaryRows — server values verbatim", () => {
  it("renders SUBTOTAL, DISCOUNT, TAX, SHIPPING in order from the server fields", () => {
    const order = makeOrder({
      subtotalMinor: 33500,
      discountMinor: 2000,
      taxMinor: 3500,
      shippingMinor: 3000,
    });
    const rows = receiptSummaryRows(order);
    expect(rows.map((r) => r.label)).toEqual([
      "SUBTOTAL",
      "DISCOUNT",
      "TAX",
      "SHIPPING",
    ]);
    expect(rows.map((r) => r.amountMinor)).toEqual([33500, 2000, 3500, 3000]);
  });

  it("marks DISCOUNT as a deduction WITHOUT negating the server value", () => {
    const order = makeOrder({ discountMinor: 2500 });
    const discount = receiptSummaryRows(order).find(
      (r) => r.label === "DISCOUNT",
    );
    expect(discount?.kind).toBe("deduction");
    expect(discount?.amountMinor).toBe(2500);
  });

  it("includes INSURANCE only when the server reports a positive amount", () => {
    const withInsurance = receiptSummaryRows(
      makeOrder({ insuranceMinor: 1500 }),
    );
    expect(withInsurance.some((r) => r.label === "INSURANCE")).toBe(true);

    const zeroInsurance = receiptSummaryRows(makeOrder({ insuranceMinor: 0 }));
    expect(zeroInsurance.some((r) => r.label === "INSURANCE")).toBe(false);
  });

  it("missing optional fields display as zero without inventing money", () => {
    const rows = receiptSummaryRows(
      makeOrder({ discountMinor: undefined, insuranceMinor: undefined }),
    );
    const discount = rows.find((r) => r.label === "DISCOUNT");
    expect(discount?.amountMinor).toBe(0);
  });
});

describe("receiptTotalRow — the frozen server total", () => {
  it("carries totalAmountMinor untouched", () => {
    const row = receiptTotalRow(makeOrder({ totalAmountMinor: 41234 }));
    expect(row.label).toBe("TOTAL");
    expect(row.amountMinor).toBe(41234);
  });

  it("never equals a locally computed sum of the summary rows", () => {
    // The server's total is authoritative even if line math disagrees.
    const order = makeOrder({
      subtotalMinor: 10000,
      taxMinor: 0,
      shippingMinor: 0,
      discountMinor: 0,
      totalAmountMinor: 99999,
    });
    const sumOfRows = receiptSummaryRows(order).reduce(
      (acc, r) => acc + (r.kind === "deduction" ? -r.amountMinor : r.amountMinor),
      0,
    );
    expect(receiptTotalRow(order).amountMinor).not.toBe(sumOfRows);
    expect(receiptTotalRow(order).amountMinor).toBe(99999);
  });
});

describe("lineFulfillmentLabel — server progress only", () => {
  it("reports FULFILLED x/y when the server reports progress", () => {
    const line = makeOrder().lineItems![0];
    expect(lineFulfillmentLabel(line)).toBe(
      `FULFILLED ${line.fulfilledQuantity}/${line.quantity}`,
    );
  });

  it("reports NOT SHIPPED when fulfillment is absent", () => {
    const base = makeOrder().lineItems![0];
    const line = { ...base, fulfilledQuantity: null };
    expect(lineFulfillmentLabel(line)).toBe("NOT SHIPPED");
  });
});
