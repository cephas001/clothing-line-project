// apps/storefront/src/lib/types.ts
//
// All backend DTOs come from `@clothing-line-project/shared-types` (generated
// from the OpenAPI spec) — the storefront NEVER recreates backend request/
// response types by hand. The local `*View` interfaces below are THIN UI
// projections built from those DTOs (see src/lib/product.ts), never a parallel
// data model: prices stay in `priceMinor` (the authoritative regional value),
// availability is derived from the server's inventory fields, and categories
// come from the category tree.

export type {
  Product,
  ProductVariant,
  Cart,
  CartLineItem,
  Category,
  Customer,
  Address,
  AddressInput,
  Order,
  OrderLineItem,
  Fulfillment,
  StandardError,
  ListProductsResponse,
  AddLineItemRequest,
  AuthenticateRequest,
  RegisterCustomerRequest,
  AuthenticateCustomerResponse,
} from "@clothing-line-project/shared-types";

/** A selectable option on the product page (projection of a ProductVariant). */
export interface VariantView {
  id: string;
  sku: string;
  label: string;
  available: boolean;
  /** Authoritative regional price in minor units (null when no price for the region). */
  priceMinor: number | null;
  inventoryQuantity: number;
  allowBackorder: boolean;
}

/**
 * One gallery entry projected from the server's ordered media[]. `alt` is the
 * server altText when present, else a meaningful positional fallback — never
 * empty (F7.1 / G034).
 */
export interface MediaView {
  url: string;
  alt: string;
}

/** Thin UI projection of a backend Product (see toProductView in ./product). */
export interface ProductView {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** Authoritative regional price of the first available variant, minor units. */
  priceMinor: number | null;
  /** ISO-4217 currency of the storefront region (display-only). */
  currencyCode: string;
  /**
   * Ordered gallery (server display order). F7.1 / G034: N-slot — renders
   * gracefully with 0, 1, or many entries; no hardcoded two-slot assumption.
   */
  media: MediaView[];
  isSoldOut: boolean;
  sellingFast: boolean;
  variants: VariantView[];
  /** Category slug derived from the category tree name (for nav/filtering). */
  category: string;
  /**
   * F7 / G012: ALL the server-assigned category ids, so navigation/filtering
   * can match any membership (not just the first) against derived groups.
   */
  categoryIds: string[];
}

/**
 * A cart line for the UI. `key` is the server line-item id (the only value
 * used for update/remove mutations). Money is ALWAYS server-sourced:
 * `unitPriceMinor` / `lineTotalMinor` come from the Cart projection. `qty` is
 * the displayed quantity (server quantity + optimistic delta); `pending` marks
 * an optimistic addition awaiting server acknowledgement.
 */
export interface CartLine {
  /** Server line item id (or a `pending__<variantId>` marker for optimistic adds). */
  key: string;
  variantId: string | null;
  qty: number;
  /** Server-authoritative unit price in minor units. */
  unitPriceMinor: number;
  /** Server-computed unitPriceMinor * quantity; undefined while a line is pending. */
  lineTotalMinor: number | undefined;
  /** UI projection resolved from the catalog (null until the catalog loads). */
  product: ProductView | null;
  variant: VariantView | null;
  /** True while a mutation for this line is in flight. */
  syncing: boolean;
  /** True for an optimistic addition not yet acknowledged by the server. */
  pending: boolean;
}

/** Optimistic addition awaiting server acknowledgement (quantity only, no money math). */
export interface CartPendingAdd {
  variantId: string;
  qty: number;
  product: ProductView;
  variant: VariantView | null;
}

/** Server-frozen shipping selection (from POST /store/carts/{id}/shipping-options). */
export interface SelectedShipping {
  quoteId: string;
  serviceLevel?: string | null;
  /** Server-validated shipping amount in minor units. */
  amountMinor: number;
  currency?: string | null;
  etaDays?: number | null;
}