// apps/api/src/adapters/http/projections.ts

// Explicit public projections for the storefront catalogue.
//
// Domain entities (Product, ProductVariant) are NEVER JSON-serialized directly:
// their mutable state lives in runtime-own underscore properties (`_title`,
// `_handle`, `Map`/`Set` collections) while the public contract fields are
// getter-backed on the prototype, so a naive `JSON.stringify` would both LEAK
// internal state and DROP the contract fields. Every entity is therefore
// reduced through these mappers to the exact fields the OpenAPI
// Product/ProductVariant schemas require — nothing more.
//
// Fields deliberately NOT exposed here (backend-private, absent from the
// OpenAPI Product schema): `salesChannelIds`, and any inventory/sourcing
// metadata. `categoryIds` and `media` ARE exposed (F4/M1): both are
// public-safe storefront data now declared on the OpenAPI Product schema. The
// AUTHORITATIVE regional price (priceMinor) IS exposed per variant: it is
// resolved in the application layer (use cases) from the pricing service —
// never invented or derived by a client — and projected here for the
// requesting region. The read cache keeps its own richer
// serialization (productReadCacheSerialization.ts) because it must RECONSTRUCT
// the domain entity on a hit; the HTTP boundary is a one-way projection.

import type { Product } from "@api/domain/entities/Product";
import type { ProductVariant } from "@api/domain/entities/ProductVariant";
import type { ProductMedia } from "@api/domain/entities/ProductMedia";
import type { ProductWithRegionalPricing } from "@api/use-cases/catalog/ProductWithPricing";
import type { Cart } from "@api/domain/entities/Cart";
import type { CartLineItem } from "@api/domain/entities/CartLineItem";
import type { Promotion } from "@api/domain/entities/Promotion";
import type { Customer } from "@api/domain/entities/Customer";
import type { Category } from "@api/domain/entities/Category";
import type { SalesChannel } from "@api/domain/entities/SalesChannel";
import type { Order } from "@api/domain/entities/Order";
import type { BusinessUnitRecord } from "@api/domain/shared/contracts";
import type { DeadLetterJob } from "@api/domain/shared/workflow";

/** Public projection matching the OpenAPI `ProductVariant` schema. */
export interface ProductVariantResponse {
  id: string;
  productId: string;
  sku: string;
  inventoryQuantity: number;
  allowBackorder: boolean;
  version: number;
  /**
   * Authoritative regional price in minor units (region currency) for the
   * requesting region, resolved server-side by the pricing service. Null when
   * no regional price exists for this variant. Never client-supplied.
   */
  priceMinor: number | null;
}

/** Public projection matching the OpenAPI `ProductMedia` schema. */
export interface ProductMediaResponse {
  id: string;
  url: string;
  kind: string;
  altText: string | null;
  sortOrder: number;
}

/** Public projection matching the OpenAPI `Product` schema. */
export interface ProductResponse {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  categoryIds: string[];
  media: ProductMediaResponse[];
  variants: ProductVariantResponse[];
}

/** Project a single media reference (public-safe fields only). */
export function toProductMediaResponse(media: ProductMedia): ProductMediaResponse {
  return {
    id: media.id,
    url: media.url,
    kind: media.kind,
    altText: media.altText,
    sortOrder: media.sortOrder,
  };
}

/** Project a single variant through its public accessors only. */
export function toProductVariantResponse(
  variant: ProductVariant,
  priceMinor: number | null,
): ProductVariantResponse {
  return {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    inventoryQuantity: variant.inventoryQuantity,
    allowBackorder: variant.allowBackorder,
    version: variant.version,
    priceMinor,
  };
}

/**
 * Project a product through its public accessors only. `priceByVariant` carries
 * the region's authoritative prices resolved by the use cases; when absent
 * (e.g. routes whose use case does not resolve pricing), each variant renders
 * `priceMinor: null` — never an invented value.
 */
export function toProductResponse(
  product: Product,
  priceByVariant?: ReadonlyMap<string, number | null>,
): ProductResponse {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    description: product.description ?? null,
    categoryIds: product.categoryIds,
    media: product.media.map(toProductMediaResponse),
    variants: product.variants.map((variant) =>
      toProductVariantResponse(
        variant,
        priceByVariant?.get(variant.id) ?? null,
      ),
    ),
  };
}

/** Project a browse result into the OpenAPI `ProductList` shape. */
export function toProductListResponse(result: {
  items: ProductWithRegionalPricing[];
  total: number;
}): { items: ProductResponse[]; total: number } {
  return {
    items: result.items.map((dto) =>
      toProductResponse(dto.product, dto.priceByVariant),
    ),
    total: result.total,
  };
}

// ---------------------------------------------------------------------------
// Cart / line-item projections (OpenAPI `Cart`, `CartLineItem`,
// `AppliedPromotion`). The Cart entity exposes public accessors for every
// projected field; the provider selection fields the cart persists for dispatch
// (shippingRequestToken, shippingCourierId, shippingServiceCode,
// shippingQuoteFingerprint) are deliberately NOT projected — they are
// application-persistence data, never client-visible.
// ---------------------------------------------------------------------------

/** Public projection matching the OpenAPI `CartLineItem` schema. */
export interface CartLineItemResponse {
  id: string;
  cartId: string;
  variantId: string | null;
  title: string | null;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Public projection matching the OpenAPI `AppliedPromotion` schema. */
export interface AppliedPromotionResponse {
  id: string;
  code: string;
}

/** Public projection matching the OpenAPI `Cart` schema. */
export interface CartResponse {
  id: string;
  regionId: string;
  salesChannelId: string;
  customerId: string | null;
  email: string | null;
  createdAt: string;
  countryCode: string | null;
  shippingAddress: Record<string, unknown> | null;
  taxAmountMinor: number | null;
  metadata: Record<string, unknown>;
  frozen: boolean;
  frozenReason: string | null;
  frozenAt: string | null;
  orderId: string | null;
  convertedAt: string | null;
  status: string;
  paymentStatus: string;
  paymentInitialized: boolean;
  paymentAuthorizationUrl: string | null;
  paymentInitializedAt: string | null;
  cartTotalMinor: number;
  items: CartLineItemResponse[];
  appliedPromotion: AppliedPromotionResponse | null;
}

function toCartLineItemResponse(item: CartLineItem): CartLineItemResponse {
  return {
    id: item.id,
    cartId: item.cartId,
    variantId: item.variantId,
    title: item.title ?? null,
    quantity: item.quantity,
    unitPriceMinor: item.unitPriceMinor,
    lineTotalMinor: item.lineTotalMinor,
    metadata: item.metadata,
    createdAt: item.createdAt,
  };
}

function toAppliedPromotionResponse(
  promotion: Promotion | null,
): AppliedPromotionResponse | null {
  if (!promotion) {
    return null;
  }
  return { id: promotion.id, code: promotion.code };
}

/** Project a cart through its public accessors only. */
export function toCartResponse(cart: Cart): CartResponse {
  return {
    id: cart.id,
    regionId: cart.regionId,
    salesChannelId: cart.salesChannelId,
    customerId: cart.customerId,
    email: cart.email,
    createdAt: cart.createdAt,
    countryCode: cart.countryCode,
    shippingAddress: cart.shippingAddress,
    taxAmountMinor: cart.taxAmountMinor,
    metadata: cart.metadata,
    frozen: cart.frozen,
    frozenReason: cart.frozenReason,
    frozenAt: cart.frozenAt,
    orderId: cart.orderId,
    convertedAt: cart.convertedAt,
    status: cart.status,
    paymentStatus: cart.paymentStatus,
    paymentInitialized: cart.paymentInitialized,
    paymentAuthorizationUrl: cart.paymentAuthorizationUrl,
    paymentInitializedAt: cart.paymentInitializedAt,
    cartTotalMinor: cart.cartTotalMinor,
    items: cart.items.map(toCartLineItemResponse),
    appliedPromotion: toAppliedPromotionResponse(cart.appliedPromotion),
  };
}

// ---------------------------------------------------------------------------
// Customer projections (OpenAPI `Customer`, `BusinessUnit`). Backend-private
// auth state (password hash, security stamp, failed-login counters, lockout,
// password-reset tokens) is NEVER projected.
// ---------------------------------------------------------------------------

/** Public projection matching the OpenAPI `Customer` schema. */
export interface CustomerResponse {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  activeCartId: string | null;
  registeredAt: string | null;
  phone: string | null;
  addresses: Array<Record<string, unknown>>;
  disabled: boolean;
  roles: string[];
  metadata: Record<string, unknown>;
}

/** Project a customer through its public accessors only. */
export function toCustomerResponse(customer: Customer): CustomerResponse {
  return {
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    activeCartId: customer.activeCartId,
    registeredAt: customer.registeredAt,
    phone: customer.phone,
    addresses: customer.addresses.map((entry) => ({ ...entry })),
    disabled: customer.disabled,
    roles: [...customer.roles],
    metadata: { ...customer.metadata },
  };
}

/** Public projection matching the OpenAPI `BusinessUnit` schema. */
export interface BusinessUnitResponse {
  id: string;
  name: string;
  registrationNumber: string;
  salesChannelId: string;
  members: Array<{ customerId: string; role: string }>;
  createdAt: string;
}

/** Project a business unit record (the contract's neutral shape) as-is. */
export function toBusinessUnitResponse(
  record: BusinessUnitRecord,
): BusinessUnitResponse {
  return {
    id: record.id,
    name: record.name,
    registrationNumber: record.registrationNumber,
    salesChannelId: record.salesChannelId,
    members: record.members.map((member) => ({
      customerId: member.customerId,
      role: member.role,
    })),
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Order projection (OpenAPI `Order`) for the customer order-history read.
// Fulfillment records on the entity are the DURABLE dispatch markers — they
// additionally carry provider-only fields (providerShipmentId,
// sourcingLocationId, and metadata.dispatchAttempt.{requestToken, courierId,
// serviceCode, providerShipmentId}) that are NEVER exposed over HTTP. Each
// record is therefore reduced through `toFulfillmentResponse`, which projects
// EXACTLY the fields the OpenAPI `Fulfillment` schema declares and strips the
// provider-only metadata keys (recursively). `lineItems`, `availableVariants`
// and `pendingReturns` are plain contract-shaped data and are spread verbatim.
// ---------------------------------------------------------------------------

/** OpenAPI `Fulfillment` schema fields (the ONLY fields exposed over HTTP). */
export interface FulfillmentResponse {
  id: string;
  orderId: string;
  trackingNumber: string | null;
  courier: string | null;
  labelUrl: string | null;
  serviceLevel: string | null;
  status: string;
  createdAt: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Provider-only keys NEVER exposed over HTTP, even inside the declared
 * `metadata` object: provider request/shipment tokens, provider selection
 * codes, and the inventory origin of a dispatch.
 */
const FULFILLMENT_PROVIDER_ONLY_KEYS: ReadonlySet<string> = new Set([
  "requestToken",
  "courierId",
  "serviceCode",
  "providerShipmentId",
  "sourcingLocationId",
  "dispatchAttempt",
]);

function readProjectedString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sanitizeFulfillmentMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FULFILLMENT_PROVIDER_ONLY_KEYS.has(key)) {
      continue;
    }
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      result[key] = sanitizeFulfillmentMetadata(entry);
    } else if (Array.isArray(entry)) {
      result[key] = entry.map((item) =>
        item !== null && typeof item === "object"
          ? sanitizeFulfillmentMetadata(item)
          : item,
      );
    } else {
      result[key] = entry;
    }
  }
  return result;
}

/** Project a fulfillment record to the OpenAPI `Fulfillment` contract only. */
function toFulfillmentResponse(
  record: Record<string, unknown>,
): FulfillmentResponse {
  const metadata = sanitizeFulfillmentMetadata(record.metadata);
  return {
    id: readProjectedString(record, "id") ?? "",
    orderId: readProjectedString(record, "orderId") ?? "",
    trackingNumber: readProjectedString(record, "trackingNumber") ?? "",
    courier: readProjectedString(record, "courier"),
    labelUrl: readProjectedString(record, "labelUrl"),
    serviceLevel: readProjectedString(record, "serviceLevel"),
    status: typeof record.status === "string" ? record.status : "",
    createdAt: readProjectedString(record, "createdAt"),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** Public projection matching the OpenAPI `Order` schema. */
export interface OrderResponse {
  id: string;
  cartId: string;
  customerId: string;
  totalAmountMinor: number;
  currency: string | null;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  insuranceMinor: number;
  fulfillmentStatus: string;
  paymentStatus: string;
  transactionReference: string | null;
  paymentStatusReason: string | null;
  paymentStatusUpdatedAt: string | null;
  flaggedForReview: boolean;
  flagReason: string | null;
  riskScore: number | null;
  flaggedAt: string | null;
  fulfillmentHaltedAt: string | null;
  createdAt: string;
  lineItems: Array<Record<string, unknown>>;
  availableVariants: Array<{ id: string; unitPriceMinor: number }>;
  fulfillments: FulfillmentResponse[];
  pendingReturns: Array<Record<string, unknown>>;
}

/** Project an order through its public accessors only. */
export function toOrderResponse(order: Order): OrderResponse {
  return {
    id: order.id,
    cartId: order.cartId,
    customerId: order.customerId,
    totalAmountMinor: order.totalAmountMinor,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    discountMinor: order.discountMinor,
    taxMinor: order.taxMinor,
    shippingMinor: order.shippingMinor,
    insuranceMinor: order.insuranceMinor,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentStatus: order.paymentStatus,
    transactionReference: order.transactionReference,
    paymentStatusReason: order.paymentStatusReason,
    paymentStatusUpdatedAt: order.paymentStatusUpdatedAt,
    flaggedForReview: order.flaggedForReview,
    flagReason: order.flagReason,
    riskScore: order.riskScore,
    flaggedAt: order.flaggedAt,
    fulfillmentHaltedAt: order.fulfillmentHaltedAt,
    createdAt: order.createdAt,
    lineItems: order.lineItems.map((line) => ({ ...line })),
    availableVariants: order.availableVariants.map((variant) => ({
      ...variant,
    })),
    fulfillments: order.fulfillments.map((record) =>
      toFulfillmentResponse(record as Record<string, unknown>),
    ),
    pendingReturns: order.pendingReturns.map((record) => ({ ...record })),
  };
}

// ---------------------------------------------------------------------------
// Admin projections (OpenAPI `Category`, `SalesChannel`, `DeadLetterJob`).
// ---------------------------------------------------------------------------

/** Public projection matching the OpenAPI `Category` schema. */
export interface CategoryResponse {
  id: string;
  name: string;
  parentCategoryId: string | null;
  createdAt: string;
}

/** Project a category through its public accessors only. */
export function toCategoryResponse(category: Category): CategoryResponse {
  return {
    id: category.id,
    name: category.name,
    parentCategoryId: category.parentCategoryId,
    createdAt: category.createdAt,
  };
}

/** Public projection matching the OpenAPI `SalesChannel` schema. */
export interface SalesChannelResponse {
  id: string;
  name: string;
  description: string | null;
  isDisabled: boolean;
  createdAt: string;
}

/** Project a sales channel through its public accessors only. */
export function toSalesChannelResponse(
  channel: SalesChannel,
): SalesChannelResponse {
  return {
    id: channel.id,
    name: channel.name,
    description: channel.description,
    isDisabled: channel.isDisabled,
    createdAt: channel.createdAt,
  };
}

/** Public projection matching the OpenAPI `DeadLetterJob` schema. */
export interface DeadLetterJobResponse {
  id: string;
  name: string | null;
  data: Record<string, unknown> | null;
  failedReason: string | null;
  attemptsMade: number | null;
  timestamp: string | null;
  failedAt: string | null;
}

/** Project a dead-letter job to the stable public shape. */
export function toDeadLetterJobResponse(job: DeadLetterJob): DeadLetterJobResponse {
  return {
    id: job.id,
    name: job.name ?? null,
    data: job.data ? { ...job.data } : null,
    failedReason: job.failedReason ?? null,
    attemptsMade: job.attemptsMade ?? null,
    timestamp: normalizeTimestamp(job.timestamp),
    failedAt: normalizeTimestamp(job.failedAt),
  };
}

function normalizeTimestamp(value: string | number | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}
