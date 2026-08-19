// apps/api/src/infrastructure/caching/productReadCacheSerialization.ts

// Safe serialization/deserialization for the product read cache.
//
// WRITE path: domain entities are reduced to plain JSON DTOs via their public
// getters (never via `any` or reflection) and wrapped in a versioned envelope
// that also echoes the cache-key hash:
//   { kind: "product-list",   keyHash, data: { items: [...], total } }
//   { kind: "product-detail", keyHash, data: ProductDto | null }
// The `keyHash` echo is defense-in-depth: even if a payload is ever stored
// under the wrong Redis key, the echo check rejects it as corrupt.
//
// READ path: a cached string is validated structurally (type guards first) and
// then RECONSTRUCTED through the domain constructors (`new ProductVariant(...)`,
// `new Product(...)`). The constructors are the final authority: any payload
// that passes the type guards but still violates an entity invariant (e.g.
// inventory above the allowed maximum) is rejected. Rejection is reported as an
// explicit `{ ok: false, reason }` result; the decorator then deletes the
// corrupt entry and falls back to Postgres. A reconstructed payload therefore
// always satisfies the same invariants as a freshly-hydrated row.

import { Product } from "@api/domain/entities/Product";
import { ProductVariant } from "@api/domain/entities/ProductVariant";

/** Serializable projection of a ProductVariant. */
export interface SerializedVariant {
  id: string;
  productId: string;
  sku: string;
  inventoryQuantity: number;
  allowBackorder: boolean;
  version: number;
}

/** Serializable projection of a Product (with its hydrated variants). */
export interface SerializedProduct {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  variants: SerializedVariant[];
  categoryIds: string[];
  salesChannelIds: string[];
}

export type ProductReadCacheKind = "product-list" | "product-detail";

export type ProductCacheParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// WRITE: entity -> DTO -> envelope string
// ---------------------------------------------------------------------------

function serializeVariant(variant: ProductVariant): SerializedVariant {
  return {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    inventoryQuantity: variant.inventoryQuantity,
    allowBackorder: variant.allowBackorder,
    version: variant.version,
  };
}

function serializeProduct(product: Product): SerializedProduct {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    description: product.description,
    variants: product.variants.map(serializeVariant),
    categoryIds: product.categoryIds,
    salesChannelIds: product.salesChannelIds,
  };
}

/** Envelope string for a findMany result. */
export function serializeProductListEnvelope(
  keyHash: string,
  result: { items: Product[]; total: number },
): string {
  return JSON.stringify({
    kind: "product-list",
    keyHash,
    data: {
      items: result.items.map(serializeProduct),
      total: result.total,
    },
  });
}

/** Envelope string for a findByIdAndContext result (null caches a miss). */
export function serializeProductDetailEnvelope(
  keyHash: string,
  product: Product | null,
): string {
  return JSON.stringify({
    kind: "product-detail",
    keyHash,
    data: product === null ? null : serializeProduct(product),
  });
}

// ---------------------------------------------------------------------------
// READ: envelope string -> validated domain entities
// ---------------------------------------------------------------------------

/** Strict array-of-strings check (our serializer only ever writes strings). */
function parseStringArray(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
  }
  return value as string[];
}

function parseVariantEntity(raw: unknown): ProductVariant | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.id !== "string" ||
    typeof raw.productId !== "string" ||
    typeof raw.sku !== "string"
  ) {
    return null;
  }
  const inventoryQuantity = raw.inventoryQuantity;
  if (
    typeof inventoryQuantity !== "number" ||
    !Number.isInteger(inventoryQuantity) ||
    inventoryQuantity < 0
  ) {
    return null;
  }
  if (typeof raw.allowBackorder !== "boolean") {
    return null;
  }
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return null;
  }
  try {
    return new ProductVariant({
      id: raw.id,
      productId: raw.productId,
      sku: raw.sku,
      inventoryQuantity,
      allowBackorder: raw.allowBackorder,
      version,
    });
  } catch {
    return null;
  }
}

function parseProductEntity(raw: unknown): Product | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.id !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.handle !== "string"
  ) {
    return null;
  }
  if (raw.description !== null && typeof raw.description !== "string") {
    return null;
  }
  if (!Array.isArray(raw.variants)) {
    return null;
  }
  const variants: ProductVariant[] = [];
  for (const rawVariant of raw.variants) {
    const variant = parseVariantEntity(rawVariant);
    if (variant === null) {
      return null;
    }
    variants.push(variant);
  }
  const categoryIds = parseStringArray(raw.categoryIds);
  const salesChannelIds = parseStringArray(raw.salesChannelIds);
  if (categoryIds === null || salesChannelIds === null) {
    return null;
  }
  try {
    return new Product({
      id: raw.id,
      title: raw.title,
      handle: raw.handle,
      description: typeof raw.description === "string" ? raw.description : undefined,
      variants,
      categoryIds,
      salesChannelIds,
    });
  } catch {
    return null;
  }
}

/**
 * Validate and decode a cached envelope string into domain entities.
 *
 * A non-`ok` result means the entry is corrupt (wrong kind, keyHash mismatch,
 * malformed shape, or a payload that violates a domain invariant): the caller
 * must discard it and treat it as a cache miss.
 */
export function parseProductCacheEnvelope(
  raw: string,
  kind: "product-list",
  keyHash: string,
): ProductCacheParseResult<{ items: Product[]; total: number }>;
export function parseProductCacheEnvelope(
  raw: string,
  kind: "product-detail",
  keyHash: string,
): ProductCacheParseResult<Product | null>;
export function parseProductCacheEnvelope(
  raw: string,
  kind: ProductReadCacheKind,
  keyHash: string,
): ProductCacheParseResult<{ items: Product[]; total: number } | Product | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "envelope is not an object" };
  }
  if (parsed.kind !== kind) {
    return { ok: false, reason: `kind mismatch: expected "${kind}"` };
  }
  if (parsed.keyHash !== keyHash) {
    return { ok: false, reason: "keyHash mismatch" };
  }

  if (kind === "product-list") {
    if (!isRecord(parsed.data)) {
      return { ok: false, reason: "list data is not an object" };
    }
    if (!Array.isArray(parsed.data.items)) {
      return { ok: false, reason: "list items is not an array" };
    }
    if (
      typeof parsed.data.total !== "number" ||
      !Number.isInteger(parsed.data.total) ||
      parsed.data.total < 0
    ) {
      return { ok: false, reason: "list total is not a non-negative integer" };
    }
    const items: Product[] = [];
    for (const rawProduct of parsed.data.items) {
      const product = parseProductEntity(rawProduct);
      if (product === null) {
        return { ok: false, reason: "list contains an invalid product" };
      }
      items.push(product);
    }
    return { ok: true, value: { items, total: parsed.data.total } };
  }

  if (parsed.data === null) {
    return { ok: true, value: null };
  }
  const product = parseProductEntity(parsed.data);
  if (product === null) {
    return { ok: false, reason: "detail data is an invalid product" };
  }
  return { ok: true, value: product };
}