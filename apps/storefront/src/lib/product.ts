// apps/storefront/src/lib/product.ts
//
// Catalog projections: backend `Product` DTO -> UI `ProductView`.
//
// The hardcoded 16-product demo catalog (RAW_PRODUCTS), the handle->slug map
// (DEV_CATEGORY) and PLACEHOLDER_PRICE are GONE. Products and categories are
// fetched from the API (src/lib/api/catalog.ts) and reduced through these pure
// functions. No business logic lives here:
//   - `priceMinor` is the AUTHORITATIVE regional price from the server — never
//     invented, derived, or substituted.
//   - availability is a projection of the server's inventory fields
//     (inventoryQuantity / allowBackorder).
//   - media urls and category names come from the server's media[] / category
//     tree.
//   - No totals are ever computed (that is server-authoritative).

import type {
  Category,
  Product,
  ProductVariant,
} from "@clothing-line-project/shared-types";
import type { MediaView, ProductView, VariantView } from "./types";
import { DEFAULT_REGION_CURRENCY } from "./api/client";

export const DEFAULT_CURRENCY = DEFAULT_REGION_CURRENCY;

function isAvailable(
  variant: Pick<ProductVariant, "inventoryQuantity" | "allowBackorder">,
): boolean {
  return variant.inventoryQuantity > 0 || variant.allowBackorder;
}

/** Normalize a category name into a stable slug (e.g. "Jackets" -> "jackets"). */
export function categorySlugOf(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "all";
}

/**
 * F7.1 / G034: map the server's ordered media[] to an N-slot gallery — 0, 1
 * or many entries, in server display order. Alt text is the server altText
 * when meaningful (non-blank), else a positional fallback built from the
 * product title so every image has accessible, non-empty alt text.
 */
export function mediaFromMedia(
  media: Product["media"] = [],
  fallbackTitle = "Product",
): MediaView[] {
  return (media ?? []).map((item, index) => ({
    url: item.url,
    alt:
      item.altText && item.altText.trim() !== ""
        ? item.altText.trim()
        : `${fallbackTitle} — image ${index + 1}`,
  }));
}

export function toVariantView(variant: ProductVariant): VariantView {
  return {
    id: variant.id,
    sku: variant.sku,
    label: variant.sku.split("-").pop() ?? variant.sku,
    available: isAvailable(variant),
    priceMinor: variant.priceMinor,
    inventoryQuantity: variant.inventoryQuantity,
    allowBackorder: variant.allowBackorder,
  };
}

/**
 * Project a backend Product into the UI view. The representative price is the
 * first available variant's authoritative priceMinor (falling back to the first
 * variant). isSoldOut/sellingFast are projections of server inventory fields.
 */
export function toProductView(
  product: Product,
  categoryName = "",
): ProductView {
  const variants = (product.variants ?? []).map(toVariantView);
  const firstAvailable =
    variants.find((variant) => variant.available) ?? variants[0] ?? null;
  const totalStock = variants.reduce(
    (sum, variant) => sum + variant.inventoryQuantity,
    0,
  );

  return {
    id: product.id,
    slug: product.handle,
    name: product.title,
    description: product.description ?? "",
    priceMinor: firstAvailable?.priceMinor ?? null,
    currencyCode: DEFAULT_CURRENCY,
    media: mediaFromMedia(product.media, product.title),
    isSoldOut: variants.length === 0 || !variants.some((variant) => variant.available),
    sellingFast: totalStock > 0 && totalStock <= 8,
    variants,
    category: categorySlugOf(categoryName),
    categoryIds: [...(product.categoryIds ?? [])],
  };
}

/** Resolve a product's first category name from the category tree. */
export function categoryNameOf(
  product: Product,
  categories: Category[],
): string {
  const id = (product.categoryIds ?? [])[0];
  if (!id) return "";
  return categories.find((category) => category.id === id)?.name ?? "";
}

// -----------------------------------------------------------------------------
// F7 / G012 — server-derived category navigation.
//
// `GET /store/product-categories` is the AUTHORITATIVE source for navigation
// (Header, Shop, Footer). No category names or slugs are hardcoded anywhere;
// an empty tree honestly yields no category entries. The tree is flat with
// parent pointers; navigation renders TOP-LEVEL categories and filtering
// matches a product against a category's whole descendant group.
// -----------------------------------------------------------------------------

/** A navigation entry derived from a server category. */
export interface NavCategory {
  id: string;
  name: string;
  slug: string;
}

/**
 * Top-level navigation entries (parentCategoryId is null). A category whose
 * parent is missing from the payload is treated as top-level — the honest
 * fallback for partial trees. Order follows the server payload.
 */
export function navCategories(categories: Category[]): NavCategory[] {
  const known = new Set(categories.map((category) => category.id));
  return categories
    .filter(
      (category) =>
        !category.parentCategoryId || !known.has(category.parentCategoryId),
    )
    .map((category) => ({
      id: category.id,
      name: category.name,
      slug: categorySlugOf(category.name),
    }));
}

/**
 * The set of ids for a category AND all its descendants (cycle-safe). Used to
 * match products that belong to any member of the group.
 */
export function categoryGroupIds(
  categoryId: string,
  categories: Category[],
): Set<string> {
  const ids = new Set<string>([categoryId]);
  let frontier = [categoryId];
  while (frontier.length > 0) {
    const next = categories
      .filter(
        (category) =>
          category.parentCategoryId != null &&
          frontier.includes(category.parentCategoryId) &&
          !ids.has(category.id),
      )
      .map((category) => category.id);
    for (const id of next) ids.add(id);
    frontier = next;
  }
  return ids;
}

export function toProductViews(
  products: Product[],
  categories: Category[],
): ProductView[] {
  return products.map((product) =>
    toProductView(product, categoryNameOf(product, categories)),
  );
}

export function findBySlug(
  views: ProductView[],
  slug: string,
): ProductView | undefined {
  return views.find((view) => view.slug === slug);
}

export function byCategory(
  views: ProductView[],
  category: string,
): ProductView[] {
  return views.filter((view) => view.category === category);
}

/**
 * Same-category fallback for "You may also like". The backend's related-
 * products endpoint is not wired (no recommendation adapter), so this derives
 * related items from the fetched browse list — never faking a backend result.
 */
export function relatedProducts(
  views: ProductView[],
  product: ProductView,
  limit = 4,
): ProductView[] {
  return views
    .filter((view) => view.category === product.category && view.id !== product.id)
    .slice(0, limit);
}