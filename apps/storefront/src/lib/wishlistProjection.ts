// apps/storefront/src/lib/wishlistProjection.ts
//
// F9 / E5 + F8-W1 — pure wishlist projection rules.
//
// The wishlist stores product IDS; the catalogue supplies the products. This
// module projects one onto the other WITHOUT ever discarding a saved id: an
// id absent from the loaded catalogue stays visible as a missing item with an
// explicit reason, so "no longer available" is communicated instead of the
// item silently vanishing.
//
// Two distinct missing reasons preserve honesty:
// - "unavailable": the loaded catalogue is COMPLETE (server total <= page),
//   so absence is authoritative — the item no longer exists / is not browsable.
// - "unresolved": the loaded catalogue page is TRUNCATED, so absence from the
//   page is NOT proof of absence from the catalogue — the item simply could
//   not be resolved right now.

import type { ProductView } from "./types";

/** Why a saved id could not be projected to a product. */
export type MissingWishlistReason = "unavailable" | "unresolved";

export interface MissingWishlistItem {
  id: string;
  reason: MissingWishlistReason;
}

/** Saved ids vs resolved products vs missing ids — all three, always. */
export interface WishlistProjection {
  /** Deduplicated saved ids in SAVED order (the user's curation order). */
  savedIds: string[];
  /** Saved ids that resolved to catalogue products, in saved order. */
  resolved: ProductView[];
  /** Saved ids that did not resolve, each with its honest reason. */
  missing: MissingWishlistItem[];
}

/**
 * Project saved ids onto the loaded catalogue page. Order follows the saved
 * list (not catalogue order); duplicate saves collapse to their first
 * occurrence; blank ids are dropped defensively (storage is untrusted).
 */
export function projectWishlist(options: {
  savedIds: string[];
  catalog: ProductView[];
  catalogComplete: boolean;
}): WishlistProjection {
  const byId = new Map(options.catalog.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const savedIds: string[] = [];
  const resolved: ProductView[] = [];
  const missing: MissingWishlistItem[] = [];

  for (const rawId of options.savedIds) {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    savedIds.push(id);
    const product = byId.get(id);
    if (product) {
      resolved.push(product);
    } else {
      missing.push({
        id,
        reason: options.catalogComplete ? "unavailable" : "unresolved",
      });
    }
  }

  return { savedIds, resolved, missing };
}

/** The four truthful content states of a rendered wishlist. */
export type WishlistContentState =
  | "empty"
  | "populated"
  | "partially-available"
  | "none-available";

export function wishlistContentState(
  projection: WishlistProjection,
): WishlistContentState {
  if (projection.savedIds.length === 0) return "empty";
  if (projection.resolved.length === 0) return "none-available";
  return projection.missing.length > 0
    ? "partially-available"
    : "populated";
}

/**
 * The explicit notice for missing items — wording differs by reason so a
 * truncated catalogue never claims an item is gone when it merely could not
 * be loaded. Returns null when nothing is missing (callers render nothing).
 */
export function missingWishlistNotice(
  count: number,
  reason: MissingWishlistReason,
): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const n = Math.trunc(count);
  const noun = n === 1 ? "item" : "items";
  if (reason === "unavailable") {
    return `${n} saved ${noun} no longer exist${n === 1 ? "s" : ""} in the catalogue.`;
  }
  return `${n} saved ${noun} could not be loaded — the loaded catalogue page is incomplete.`;
}

// ---------------------------------------------------------------------------
// F10 — per-item missing presentation hierarchy
//
// 1. A KNOWN product title (only if a caller can supply one from data it has
//    already loaded — never via per-id fetching) becomes the heading.
// 2./3. The reason stays explicit: authoritative absence vs not-loaded-yet.
// 4. Without a title the saved id is rendered as a clearly-labelled REFERENCE
//    (secondary diagnostic), never dressed up as a product name.
// ---------------------------------------------------------------------------

/** Status line vocabulary — the two honest reasons stay visually distinct. */
export type MissingWishlistStatusLabel =
  | "NO LONGER AVAILABLE"
  | "NOT LOADED — CATALOGUE INCOMPLETE";

export interface MissingWishlistPresentation {
  /** Primary heading: the product title when known, else a neutral label. */
  heading: string;
  /** True only when `heading` is an actual product title. */
  headingIsTitle: boolean;
  /** The honest status line distinguishing unavailable from unresolved. */
  statusLabel: MissingWishlistStatusLabel;
  /**
   * The saved id as a SECONDARY diagnostic reference — present only when no
   * title is known, always rendered under an explicit "REF" caption so it is
   * never mistaken for a name.
   */
  diagnosticId: string | null;
}

/**
 * Project one missing saved item onto its presentation. No HTTP happens here
 * or in callers: a title may only come from data already loaded on the page.
 */
export function presentMissingWishlistItem(input: {
  id: string;
  reason: MissingWishlistReason;
  /** Optional title from already-loaded data; absent/null/blank = unknown. */
  title?: string | null;
}): MissingWishlistPresentation {
  const id = input.id.trim();
  const title = input.title?.trim() ?? "";
  const statusLabel: MissingWishlistStatusLabel =
    input.reason === "unavailable"
      ? "NO LONGER AVAILABLE"
      : "NOT LOADED — CATALOGUE INCOMPLETE";
  if (title) {
    return {
      heading: title,
      headingIsTitle: true,
      statusLabel,
      diagnosticId: null,
    };
  }
  return {
    heading: "SAVED ITEM",
    headingIsTitle: false,
    statusLabel,
    diagnosticId: id || "(unknown reference)",
  };
}
