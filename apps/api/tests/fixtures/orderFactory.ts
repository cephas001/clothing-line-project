// apps/api/tests/fixtures/orderFactory.ts
//
// Deterministic Order fixtures for the swap/refund integration suites. The
// order mirrors a real finalized checkout: a frozen financial snapshot
// (currency, subtotal, discount, tax, shipping, insurance), a transaction
// reference, fulfilled line items, and a captured payment obligation.
//
// Default finances (integer minor units):
//   line-1 2x25000 (fulfilled 2) + line-2 1x10000 (fulfilled 1)
//   -> subtotal 60_000 - discount 5_000 + tax 3_000 + shipping 2_500
//      + insurance 500 = 61_000 total, charged as 61_000 captured.
//
// Returning 1 of line-1 (unit 25_000) is the canonical swap input:
//   originalValueMinor = 25_000
//   new price 30_000 -> variance +5_000  (upcharge)
//   new price 25_000 -> variance 0       (even exchange)
//   new price 20_000 -> variance -5_000  (refund)

import { Order } from "@api/domain/entities/Order";
import { Payment } from "@api/domain/entities/Payment";

export const SWAP_ORDER_ID = "order-1";
export const SWAP_CART_ID = "cart-1";
export const SWAP_CUSTOMER_ID = "customer-1";
export const SWAP_TRANSACTION_REFERENCE = "CLP-checkout-cart-1";
export const RETURN_LINE_ITEM_ID = "line-1";
export const RETURN_VARIANT_ID = "variant-1";

export interface SwapOrderOptions {
  id?: string;
  cartId?: string;
  customerId?: string;
  /** Pass `null` explicitly to build an order WITHOUT a transaction reference. */
  transactionReference?: string | null;
  totalAmountMinor?: number;
}

/**
 * The canonical finalized order the swap flows operate on. Line-1 has
 * `fulfilledQuantity = 2` so a return of 1 is legal.
 */
export function buildSwapOrder(options: SwapOrderOptions = {}): Order {
  return new Order({
    id: options.id ?? SWAP_ORDER_ID,
    cartId: options.cartId ?? SWAP_CART_ID,
    customerId: options.customerId ?? SWAP_CUSTOMER_ID,
    totalAmountMinor: options.totalAmountMinor ?? 61000,
    currency: "ngn",
    subtotalMinor: 60000,
    discountMinor: 5000,
    taxMinor: 3000,
    shippingMinor: 2500,
    insuranceMinor: 500,
    transactionReference:
      options.transactionReference === undefined
        ? SWAP_TRANSACTION_REFERENCE
        : options.transactionReference,
    paymentStatus: "captured",
    lineItems: [
      {
        id: "line-1",
        variantId: "variant-1",
        quantity: 2,
        unitPriceMinor: 25000,
        fulfilledQuantity: 2,
      },
      {
        id: "line-2",
        variantId: "variant-2",
        quantity: 1,
        unitPriceMinor: 10000,
        fulfilledQuantity: 1,
      },
    ],
  });
}

/**
 * The captured payment obligation backing the order (what the refund guard
 * locks against). Its reference equals the order's transaction reference, so
 * `lockPaymentForUpdate(order.transactionReference)` resolves it. The default
 * breakdown sums to the order total; an override allows a SMALLER captured
 * amount so over-refund and cumulative-guard tests can be exercised.
 */
export function buildCapturedPayment(
  options: { capturedAmountMinor?: number } = {},
): Payment {
  const capturedAmountMinor = options.capturedAmountMinor ?? 61000;
  return new Payment({
    id: "payment-checkout-1",
    obligationType: "checkout",
    obligationId: SWAP_CART_ID,
    reference: SWAP_TRANSACTION_REFERENCE,
    amountMinor: capturedAmountMinor,
    currency: "ngn",
    subtotalMinor: capturedAmountMinor,
    discountMinor: 0,
    taxMinor: 0,
    shippingMinor: 0,
    insuranceMinor: 0,
    status: "captured",
    providerReference: "pay-CLP-checkout-cart-1",
    providerPaymentUrl: "https://pay.example/authorize/CLP-checkout-cart-1",
  });
}
