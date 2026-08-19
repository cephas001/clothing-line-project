// apps/api/tests/fixtures/cartFactory.ts
//
// Builds PAYMENT-READY carts: a complete, current, internally-consistent
// server-validated shipping selection (hasShippingSelection +
// isShippingQuoteCurrent + isShippingSelectionConsistent), a region-consistent
// shipping currency, a contact email, and a bound customer — exactly the state
// InitializePaymentSessionUseCase requires before it will claim a durable
// obligation.
//
// Default fixture finances (all integer minor units):
//   items        line-1 2x25000 + line-2 1x10000 -> subtotal 60_000
//   discount     fixed 5_000                      -> discount  5_000
//   tax          3_000
//   shipping     2_500
//   insurance      500
//   TOTAL                                       = 61_000

import { Cart } from "@api/domain/entities/Cart";
import { CartLineItem } from "@api/domain/entities/CartLineItem";
import { Promotion } from "@api/domain/entities/Promotion";
import { ShippingQuote } from "@api/domain/shared/contracts";
import type { JsonObject } from "@api/domain/shared/json";

export interface CheckoutCartItem {
  id?: string;
  variantId?: string | null;
  quantity: number;
  unitPriceMinor: number;
  title?: string;
}

export interface CheckoutCartOptions {
  id?: string;
  regionId?: string;
  salesChannelId?: string;
  customerId?: string | null;
  email?: string | null;
  items?: CheckoutCartItem[];
  promotion?: Promotion | null;
  taxAmountMinor?: number | null;
  insuranceAmountMinor?: number | null;
  shippingAmountMinor?: number;
  shippingCurrency?: string;
  shippingQuotes?: ShippingQuote[];
  shippingAddress?: JsonObject | null;
  countryCode?: string | null;
}

const DEFAULT_ITEMS: CheckoutCartItem[] = [
  { id: "line-1", variantId: "variant-1", quantity: 2, unitPriceMinor: 25000, title: "Classic Tee" },
  { id: "line-2", variantId: "variant-2", quantity: 1, unitPriceMinor: 10000, title: "Canvas Belt" },
];

/**
 * Build a payment-ready cart. Records the server-validated quotes and applies
 * the selected shipping quote so the cart's fingerprint, selection, and
 * durable amounts are all consistent (the same sequence the checkout flow
 * performs).
 */
export function buildCheckoutCart(
  options: CheckoutCartOptions = {},
): Cart {
  const id = options.id ?? "cart-1";
  const items = options.items ?? DEFAULT_ITEMS;
  const shippingAmountMinor = options.shippingAmountMinor ?? 2500;
  const shippingCurrency = options.shippingCurrency ?? "ngn";

  const cart = new Cart({
    id,
    regionId: options.regionId ?? "region-ng",
    salesChannelId: options.salesChannelId ?? "sales-channel-main",
    customerId: options.customerId ?? "customer-1",
    email: options.email ?? "buyer@example.com",
    countryCode: options.countryCode ?? "NG",
    shippingAddress:
      options.shippingAddress ?? {
        firstName: "Ada",
        lastName: "Okafor",
        line1: "1 Marina Street",
        city: "Lagos",
        state: "Lagos",
        postalCode: "101001",
        countryCode: "NG",
        phone: "+2348000000000",
      },
    taxAmountMinor: options.taxAmountMinor ?? null,
    insuranceAmountMinor: options.insuranceAmountMinor ?? null,
    appliedPromotion: options.promotion ?? null,
    items: items.map((item, index) => {
      const title = item.title ?? `Item ${index + 1}`;
      const variantId = item.variantId ?? `variant-${index + 1}`;
      return new CartLineItem({
        id: item.id ?? `line-${index + 1}`,
        cartId: id,
        variantId,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        title,
        createdAt: new Date().toISOString(),
      });
    }),
  });

  const quotes =
    options.shippingQuotes ?? [
      {
        id: "quote-1",
        serviceLevel: "Express",
        amountMinor: shippingAmountMinor,
        currency: shippingCurrency,
        etaDays: 3,
        courierId: "courier-1",
        serviceCode: "SC-EXPRESS",
        requestToken: "request-token-1",
      },
    ];

  cart.recordShippingQuotes(quotes);

  if (quotes.length > 0) {
    const selected = quotes[0];
    cart.applySelectedShippingQuote({
      quoteId: selected.id ?? "quote-1",
      courierId: selected.courierId ?? "courier-1",
      serviceCode: selected.serviceCode ?? "SC-EXPRESS",
      requestToken: selected.requestToken ?? "request-token-1",
      amountMinor: selected.amountMinor ?? shippingAmountMinor,
      serviceLevel: selected.serviceLevel ?? null,
      currency: selected.currency ?? shippingCurrency,
      etaDays: selected.etaDays ?? null,
    });
  }

  return cart;
}

/** Build a cart with NO shipping selection (payment must refuse to initialize). */
export function buildCartWithoutShipping(
  options: Omit<CheckoutCartOptions, "shippingAmountMinor"> = {},
): Cart {
  return buildCheckoutCart({
    ...options,
    shippingQuotes: [],
  });
}