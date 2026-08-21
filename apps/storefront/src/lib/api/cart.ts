// apps/storefront/src/lib/api/cart.ts
//
// Cart + Checkout API functions.
//
// The server is the SINGLE authority for cart state and money. Every request/
// response type comes from `@clothing-line-project/shared-types` (generated
// from the OpenAPI spec) — the storefront never recreates backend DTOs and
// never submits totals, prices, tax, shipping amounts, or a customerId.
//
// All cart endpoints support guest checkout (security: []); the merge endpoint
// is the ONLY one that requires a bearer JWT (inherits global bearerAuth).
// Money is always server-authoritative: the Cart projection carries computed
// `cartTotalMinor` / `lineTotalMinor` / `taxAmountMinor`, the shipping option
// response carries the frozen `amountMinor`, and payment-sessions accepts only
// a `returnUrl` hint.

import { request } from "./client";
import type {
  AddLineItemRequest,
  ApplyDiscountRequest,
  Cart,
  CartLineItem,
  InitializeCartRequest,
  MergeGuestCartRequest,
  PaymentSessionRequest,
  PaymentSessionResponse,
  SelectShippingOptionRequest,
  SetShippingAddressRequest,
  ShippingAddress,
  ShippingOptionSelectedResponse,
  ShippingQuote,
  UpdateLineItemQuantityRequest,
} from "@clothing-line-project/shared-types";

// ---------------------------------------------------------------------------
// Cart session lifecycle
// ---------------------------------------------------------------------------

/** POST /store/carts — create a cart session bound to the storefront region/channel. */
export function initializeCartSession(
  input: InitializeCartRequest,
): Promise<Cart> {
  return request<Cart>("/store/carts", {
    method: "POST",
    body: input,
  });
}

/** GET /store/carts/{id} — the authoritative cart projection. */
export function getCart(id: string): Promise<Cart> {
  return request<Cart>(`/store/carts/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

/** POST /store/carts/{id}/line-items — add a variant line (server prices it). */
export function addCartLineItem(
  id: string,
  input: AddLineItemRequest,
): Promise<void> {
  return request<void>(`/store/carts/${encodeURIComponent(id)}/line-items`, {
    method: "POST",
    body: input,
  });
}

/** PUT /store/carts/{id}/line-items/{line_id} — set the quantity (server re-checks inventory). */
export function updateCartLineItemQuantity(
  id: string,
  lineId: string,
  input: UpdateLineItemQuantityRequest,
): Promise<void> {
  return request<void>(
    `/store/carts/${encodeURIComponent(id)}/line-items/${encodeURIComponent(lineId)}`,
    { method: "PUT", body: input },
  );
}

/** DELETE /store/carts/{id}/line-items/{line_id} — remove a line. */
export function removeCartLineItem(id: string, lineId: string): Promise<void> {
  return request<void>(
    `/store/carts/${encodeURIComponent(id)}/line-items/${encodeURIComponent(lineId)}`,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

/** POST /store/carts/{id}/discount — apply a promotion code (server validates + computes). */
export function applyCartDiscount(
  id: string,
  input: ApplyDiscountRequest,
): Promise<void> {
  return request<void>(`/store/carts/${encodeURIComponent(id)}/discount`, {
    method: "POST",
    body: input,
  });
}

// ---------------------------------------------------------------------------
// Customer merge (requires a bearer JWT — the only authenticated cart call)
// ---------------------------------------------------------------------------

/** POST /store/carts/{id}/merge — bind a guest cart to the authenticated customer. */
export function mergeGuestCart(
  id: string,
  input: MergeGuestCartRequest,
): Promise<void> {
  return request<void>(`/store/carts/${encodeURIComponent(id)}/merge`, {
    method: "POST",
    body: input,
    auth: true,
  });
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** PUT /store/carts/{id}/shipping-address — store the address; server recomputes tax. */
export function setCartShippingAddress(
  id: string,
  input: SetShippingAddressRequest,
): Promise<void> {
  return request<void>(
    `/store/carts/${encodeURIComponent(id)}/shipping-address`,
    { method: "PUT", body: input },
  );
}

/** POST /store/carts/{id}/shipping-quotes — server-fetched, provider-neutral quotes. */
export function getShippingQuotes(id: string): Promise<ShippingQuote[]> {
  return request<ShippingQuote[]>(
    `/store/carts/${encodeURIComponent(id)}/shipping-quotes`,
    { method: "POST" },
  );
}

/** POST /store/carts/{id}/shipping-options — select a server quote (only a quoteId). */
export function selectShippingOption(
  id: string,
  input: SelectShippingOptionRequest,
): Promise<ShippingOptionSelectedResponse> {
  return request<ShippingOptionSelectedResponse>(
    `/store/carts/${encodeURIComponent(id)}/shipping-options`,
    { method: "POST", body: input },
  );
}

/**
 * POST /store/carts/{id}/payment-sessions — initialize the gateway intent.
 * The amount/currency are computed server-side and durably persisted as the
 * payment obligation BEFORE the gateway is contacted; the frontend only ever
 * supplies an optional `returnUrl`. The returned `authorizationUrl` is the
 * hosted gateway page the browser is redirected to.
 */
export function initializePaymentSession(
  id: string,
  input: PaymentSessionRequest = {},
): Promise<PaymentSessionResponse> {
  return request<PaymentSessionResponse>(
    `/store/carts/${encodeURIComponent(id)}/payment-sessions`,
    { method: "POST", body: input },
  );
}

// Re-export for consumers that only need the types.
export type { CartLineItem, ShippingAddress };