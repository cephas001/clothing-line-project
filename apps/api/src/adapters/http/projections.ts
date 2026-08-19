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
// OpenAPI Product schema): `categoryIds`, `salesChannelIds`, and any
// inventory/sourcing/pricing metadata. The read cache keeps its own richer
// serialization (productReadCacheSerialization.ts) because it must RECONSTRUCT
// the domain entity on a hit; the HTTP boundary is a one-way projection.

import type { Product } from "@api/domain/entities/Product";
import type { ProductVariant } from "@api/domain/entities/ProductVariant";

/** Public projection matching the OpenAPI `ProductVariant` schema. */
export interface ProductVariantResponse {
  id: string;
  productId: string;
  sku: string;
  inventoryQuantity: number;
  allowBackorder: boolean;
  version: number;
}

/** Public projection matching the OpenAPI `Product` schema. */
export interface ProductResponse {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  variants: ProductVariantResponse[];
}

/** Project a single variant through its public accessors only. */
export function toProductVariantResponse(
  variant: ProductVariant,
): ProductVariantResponse {
  return {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    inventoryQuantity: variant.inventoryQuantity,
    allowBackorder: variant.allowBackorder,
    version: variant.version,
  };
}

/** Project a product through its public accessors only. */
export function toProductResponse(product: Product): ProductResponse {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    description: product.description ?? null,
    variants: product.variants.map(toProductVariantResponse),
  };
}

/** Project a browse result into the OpenAPI `ProductList` shape. */
export function toProductListResponse(result: {
  items: Product[];
  total: number;
}): { items: ProductResponse[]; total: number } {
  return {
    items: result.items.map(toProductResponse),
    total: result.total,
  };
}
