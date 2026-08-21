// apps/storefront/src/lib/receiptRows.ts
//
// F9 / E6 — pure order-receipt row presentation.
//
// Every value rendered on the order detail page comes VERBATIM from the
// server's public Order projection (GET /store/orders/{id}). This module
// decides WHICH rows exist and HOW they are labelled — it never adds,
// subtracts, or derives money. The only arithmetic-adjacent rule is the
// INSURANCE row's visibility (a server field compared to zero) and the
// DISCOUNT row's display kind (the raw server value, marked as a deduction
// so the VIEW can render the sign without recomputing anything).

import type { Order, OrderLineItem } from "@clothing-line-project/shared-types";

export interface ReceiptMoneyRow {
  label: string;
  /** The server's value, untouched. */
  amountMinor: number;
  /**
   * "charge" rows render as-is; "deduction" rows carry a RAW positive server
   * value that the view displays with a minus sign — no negation math here.
   */
  kind: "charge" | "deduction";
}

/**
 * The SUMMARY rows, in display order: SUBTOTAL, DISCOUNT, TAX, SHIPPING and —
 * only when the server reports one — INSURANCE. Missing optional fields fall
 * back to zero for DISPLAY only; no total is ever computed here.
 */
export function receiptSummaryRows(order: Order): ReceiptMoneyRow[] {
  const rows: ReceiptMoneyRow[] = [
    { label: "SUBTOTAL", amountMinor: order.subtotalMinor ?? 0, kind: "charge" },
    { label: "DISCOUNT", amountMinor: order.discountMinor ?? 0, kind: "deduction" },
    { label: "TAX", amountMinor: order.taxMinor ?? 0, kind: "charge" },
    { label: "SHIPPING", amountMinor: order.shippingMinor ?? 0, kind: "charge" },
  ];
  if ((order.insuranceMinor ?? 0) > 0) {
    rows.push({
      label: "INSURANCE",
      amountMinor: order.insuranceMinor ?? 0,
      kind: "charge",
    });
  }
  return rows;
}

/** The TOTAL row — the server's frozen totalAmountMinor, never derived. */
export function receiptTotalRow(order: Order): ReceiptMoneyRow {
  return {
    label: "TOTAL",
    amountMinor: order.totalAmountMinor,
    kind: "charge",
  };
}

/**
 * A line item's fulfillment caption from server fields only:
 * "FULFILLED x/y" when the server reports progress, "NOT SHIPPED" otherwise.
 */
export function lineFulfillmentLabel(line: OrderLineItem): string {
  return line.fulfilledQuantity != null
    ? `FULFILLED ${line.fulfilledQuantity}/${line.quantity}`
    : "NOT SHIPPED";
}
