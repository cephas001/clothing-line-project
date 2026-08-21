// apps/storefront/src/lib/shopPresentation.ts
//
// F9 / E2 — pure presentation rules for the Shop view.
//
// Every decision ShopView makes about tabs, filtering, truncation copy and
// degradation notices lives here as a testable function of its inputs. No
// React, no fetching, no financial data — just honest presentation math.
//
// Honesty contract (F8-S1): a failed category-tree request is NEVER rendered
// as success and NEVER discarded. The tree's failure degrades only the
// collection-scoped features (tabs/group filtering), which are announced,
// while product browsing continues from real server data.

import type { ProductView } from "./types";
import type { NavCategory } from "./product";

/** One filter tab: "all" or a top-level category slug. */
export interface ShopTab {
  key: string;
  label: string;
}

/**
 * The category-tree's usability for collection scoping. "ready" covers both a
 * loaded tree AND an honestly empty one (only ALL exists); "loading" means
 * scoping cannot be decided YET; "failed" means the request errored and must
 * stay visible with a retry affordance.
 */
export type ShopTreeState = "ready" | "loading" | "failed";

/** Map the async tree status onto the honest scoping state. */
export function resolveShopTreeState(
  treeStatus: "loading" | "success" | "empty" | "error",
): ShopTreeState {
  switch (treeStatus) {
    case "loading":
      return "loading";
    case "error":
      return "failed";
    default:
      return "ready";
  }
}

/**
 * The tab list: ALL first, then every top-level category in SERVER payload
 * order. An unknown ?category= slug is kept as an extra tab so the URL state
 * stays visible (F7/G031) — it honestly yields zero matches rather than
 * silently resetting to ALL.
 */
export function buildShopTabs(
  categories: NavCategory[],
  activeSlug: string,
): ShopTab[] {
  const derived = categories.map((category) => ({
    key: category.slug,
    label: category.name.toUpperCase(),
  }));
  if (activeSlug !== "all" && !derived.some((tab) => tab.key === activeSlug)) {
    return [
      { key: "all", label: "ALL" },
      { key: activeSlug, label: slugToLabel(activeSlug) },
      ...derived,
    ];
  }
  return [{ key: "all", label: "ALL" }, ...derived];
}

/** A slug is human-readable text; render it uppercased without inventing names. */
function slugToLabel(slug: string): string {
  return slug.toUpperCase();
}

/**
 * Filter the loaded catalogue page for the shop grid: by a category's whole
 * descendant group (when one is resolvable) and/or by name query. A null
 * group means "no category scoping is possible right now" (tree loading,
 * failed, or ALL selected) — products are then scoped by query alone.
 */
export function filterShopProducts(
  products: ProductView[],
  options: { groupIds: ReadonlySet<string> | null; query: string },
): ProductView[] {
  let list = products;
  const { groupIds, query } = options;
  if (groupIds) {
    list = list.filter((p) => p.categoryIds.some((id) => groupIds.has(id)));
  }
  const q = query.trim().toLowerCase();
  if (q) {
    list = list.filter((p) => p.name.toLowerCase().includes(q));
  }
  return list;
}

/**
 * F9 — the honest truncation line. Returns null when the loaded page IS the
 * complete result set (or inputs are unusable), so callers render nothing
 * instead of a false warning. When the server's total exceeds the page, the
 * message states exactly what is shown — no pagination is implied or offered
 * (the browse contract has no storefront pagination parameters).
 */
export function truncatedCatalogLine(
  shownCount: number,
  totalCount: number,
): string | null {
  if (!Number.isFinite(shownCount) || !Number.isFinite(totalCount)) return null;
  const shown = Math.max(0, Math.trunc(shownCount));
  const total = Math.max(0, Math.trunc(totalCount));
  if (total <= shown) return null;
  return `Showing the first ${shown} of ${total} matching products in the catalogue.`;
}

/**
 * F10 — PDP truncation honesty. The dedicated product-detail fetch is
 * authoritative for the VIEWED product, but related items and the slug index
 * resolve against the (possibly truncated) browse list, so a limited catalogue
 * must be stated on the page too. Gated on the hook's authoritative boolean;
 * the copy itself comes from truncatedCatalogLine so Shop and PDP can never
 * drift apart. No pagination is implied or offered.
 */
export function pdpTruncationNotice(input: {
  catalogTruncated: boolean;
  shownCount: number;
  totalCount: number;
}): string | null {
  if (!input.catalogTruncated) return null;
  return truncatedCatalogLine(input.shownCount, input.totalCount);
}

/**
 * F10 — the Shop heading, derived from SERVER data only. A known category's
 * actual display name becomes the heading (uppercased for display); every
 * other case — ALL selected, an unknown ?category= slug, or the tree still
 * loading/failed/empty — honestly falls back to "SHOP ALL". Nothing is ever
 * hardcoded and no name is invented from a slug.
 */
export function shopHeading(categoryName: string | null): string {
  const name = categoryName?.trim() ?? "";
  return name ? name.toUpperCase() : "SHOP ALL";
}

/**
 * F8-S1 — the notice rendered when the category tree fails. The failure is
 * never hidden: browsing continues from the loaded catalogue, but collection
 * scoping is explicitly declared unavailable (and named when a ?category=
 * slug was requested).
 */
export function shopTreeFailureNotice(
  hasActiveCategorySlug: boolean,
): string {
  if (hasActiveCategorySlug) {
    return "Collections are temporarily unavailable — showing everything in the loaded catalogue. Collection filtering is paused until collections load.";
  }
  return "Collections are temporarily unavailable — showing everything in the loaded catalogue.";
}

/**
 * F9 / S1 — minimum interval between category-tree retry clicks. Rapid clicks
 * inside the window are ignored (the in-flight run already supersedes them);
 * this keeps a nervous clicker from queueing a storm of identical requests.
 */
export const MIN_TREE_RETRY_INTERVAL_MS = 750;

/** Whether a tree retry click may proceed, given the last attempt time. */
export function shouldAllowRetry(
  lastAttemptMs: number | null,
  nowMs: number,
  minIntervalMs: number = MIN_TREE_RETRY_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  if (lastAttemptMs === null || !Number.isFinite(lastAttemptMs)) return true;
  return nowMs - lastAttemptMs >= minIntervalMs;
}
