// apps/storefront/src/lib/api/catalog.ts
//
// Catalog API functions + a small in-memory catalog cache.
//
// Every request/response type comes from `@clothing-line-project/shared-types`
// (generated from the OpenAPI spec) — the storefront never recreates backend
// DTOs by hand. Catalog reads are PUBLIC (no token) and REQUIRE the storefront
// region/sales-channel context headers so `priceMinor` is resolved for the
// storefront's region.
//
// The search endpoint (`GET /store/products/search`) and the related-products
// endpoint (`GET /store/products/{id}/related`) are NOT wired in the backend
// (no search/recommendation adapter), so they are intentionally NOT exposed as
// functions here — the storefront uses client-side filtering of the browse
// list instead (see src/lib/catalog.ts). Never fake a backend capability.

import { request } from "./client";
import type {
  Category,
  ListProductsResponse,
  Product,
  VariantAvailability,
} from "@clothing-line-project/shared-types";

export interface ListProductsParams {
  searchQuery?: string;
  categoryId?: string;
  limit?: number;
  offset?: number;
}

/** GET /store/products — paginated, region-scoped catalogue browse. */
export function listProducts(
  params: ListProductsParams = {},
): Promise<ListProductsResponse> {
  const query = new URLSearchParams();
  if (params.searchQuery) query.set("searchQuery", params.searchQuery);
  if (params.categoryId) query.set("categoryId", params.categoryId);
  query.set("limit", String(params.limit ?? 200));
  query.set("offset", String(params.offset ?? 0));
  const qs = query.toString();
  return request<ListProductsResponse>(`/store/products${qs ? `?${qs}` : ""}`, {
    storefrontContext: true,
  });
}

/** GET /store/product-categories — flat category tree (parent pointers). */
export function listCategories(): Promise<Category[]> {
  return request<Category[]>("/store/product-categories");
}

/**
 * F7.1 / G018 — GET /store/products/{id}: dedicated product-detail fetch so
 * the PDP renders authoritative, fresh data instead of depending exclusively
 * on the (possibly truncated) cached browse list.
 */
export function getProduct(productId: string): Promise<Product> {
  return request<Product>(
    `/store/products/${encodeURIComponent(productId)}`,
    { storefrontContext: true },
  );
}

/**
 * F7.1 / G017 — GET /store/variants/{id}/availability: live inventory,
 * backorder flag and regional price for one variant. Public read; the
 * storefront context headers scope the regional price.
 */
export function getVariantAvailability(
  variantId: string,
): Promise<VariantAvailability> {
  return request<VariantAvailability>(
    `/store/variants/${encodeURIComponent(variantId)}/availability`,
    { storefrontContext: true },
  );
}

// ---------------------------------------------------------------------------
// Shared catalog payload (products + categories) with per-session caches so
// multiple components (home, shop, PDP, wishlist, cart) reuse ONE fetch.
//
// F9 / S1: the two reads are cached INDEPENDENTLY so a category-tree failure
// can be retried WITHOUT refetching products. A rejected request NEVER poisons
// its cache slot — the slot clears itself on rejection, so a later call (or
// retry) genuinely re-fetches instead of replaying the failure forever.
// ---------------------------------------------------------------------------

export interface CatalogPayload {
  products: Product[];
  categories: Category[];
  /**
   * F7.1 / G019: the server's total matching count. When `total >
   * products.length` the browse page is TRUNCATED (the fetch already uses the
   * contract maximum limit of 200) — callers must not treat the list as
   * complete and the PDP resolves details through its dedicated fetch.
   */
  total: number;
}

let productsRequest: Promise<ListProductsResponse> | null = null;

function listProductsCached(): Promise<ListProductsResponse> {
  if (!productsRequest) {
    productsRequest = listProducts({ limit: 200 }).catch((err: unknown) => {
      productsRequest = null;
      throw err;
    });
  }
  return productsRequest;
}

let categoriesRequest: Promise<Category[]> | null = null;

/** The cached category-tree read (retryable independently of products). */
export function listCategoriesCached(): Promise<Category[]> {
  if (!categoriesRequest) {
    categoriesRequest = listCategories().catch((err: unknown) => {
      categoriesRequest = null;
      throw err;
    });
  }
  return categoriesRequest;
}

let catalogRequest: Promise<CatalogPayload> | null = null;

/** Fetch the browse list + category tree once and reuse it across the page. */
export function getCatalog(): Promise<CatalogPayload> {
  if (!catalogRequest) {
    catalogRequest = Promise.all([
      listProductsCached(),
      listCategoriesCached(),
    ])
      .then(([list, categories]) => ({
        products: list.items,
        categories,
        // G019: keep the server's count metadata instead of discarding it.
        total: list.total,
      }))
      .catch((err: unknown) => {
        catalogRequest = null;
        throw err;
      });
  }
  return catalogRequest;
}

/** Bust the whole shared catalog cache (full refresh flows). */
export function clearCatalogCache(): void {
  catalogRequest = null;
  productsRequest = null;
  categoriesRequest = null;
}

/** Bust ONLY the category-tree cache (F9/S1 tree-scoped retry). */
export function clearCategoriesCache(): void {
  categoriesRequest = null;
}