// apps/storefront/src/lib/homeSections.ts
//
// F9 / E1 — Home section derivation (pure rules, no React, no HTTP).
//
// The home page's collection teasers are DERIVED from two authoritative
// projections — the server category tree (GET /store/product-categories) and
// the region-scoped browse list — never from hardcoded slugs or names:
//
//   - Sections are the TOP-LEVEL categories (same rule as Header/Footer
//     navigation: a category whose parent is absent from the payload is
//     honestly treated as top-level), in SERVER PAYLOAD ORDER.
//   - A product belongs to a section when any of its categoryIds falls inside
//     that category's whole descendant group (same matching rule as Shop).
//   - A product whose categories are all missing from the tree belongs to NO
//     section — it is never fabricated into one (it remains reachable via
//     SHOP ALL).
//   - A category with no matching products in the browse projection yields a
//     section with zero items; the presentation layer classifies it as an
//     EMPTY COLLECTION and says so — it NEVER claims "sold out" (the server
//     provides no such category-level state).
//
// Ordinals ("01", "02") are positional presentation, not data.

import type { Category } from "@clothing-line-project/shared-types";
import type { ProductView } from "./types";
import { categoryGroupIds, navCategories } from "./product";

/** Maximum teasers rendered per home section (presentation constant). */
export const HOME_SECTION_PRODUCT_LIMIT = 4;

export interface HomeSection {
  /** Server category id — stable React key. */
  key: string;
  /** Positional ordinal in server order ("01", "02", ...). */
  index: string;
  /** Server category name verbatim (the view applies uppercase styling). */
  label: string;
  slug: string;
  href: string;
  /** Up to HOME_SECTION_PRODUCT_LIMIT products of the category group. */
  items: ProductView[];
}

/**
 * Derive the home sections from authoritative projections. Server ordering is
 * preserved end-to-end: section order follows the category payload, and item
 * order within a section follows the browse list.
 */
export function buildHomeSections(
  categories: Category[],
  views: ProductView[],
): HomeSection[] {
  return navCategories(categories).map((category, position) => {
    const groupIds = categoryGroupIds(category.id, categories);
    const items = views
      .filter((view) =>
        view.categoryIds.some((id) => groupIds.has(id)),
      )
      .slice(0, HOME_SECTION_PRODUCT_LIMIT);
    return {
      key: category.id,
      index: String(position + 1).padStart(2, "0"),
      label: category.name,
      slug: category.slug,
      href: `/shop?category=${category.slug}`,
      items,
    };
  });
}

/**
 * How a section's content area should be presented. Only TWO states exist:
 * populated (render the product grid) or empty-collection (say the collection
 * has nothing yet). There is deliberately NO "sold out" state — the server
 * provides no category-level sold-out fact, so none may be claimed.
 */
export type HomeSectionContentState = "populated" | "empty-collection";

export function sectionContentState(
  items: ProductView[],
): HomeSectionContentState {
  return items.length > 0 ? "populated" : "empty-collection";
}
