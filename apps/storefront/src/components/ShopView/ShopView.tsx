"use client";

import { useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCatalog, useCategoryTree } from "@/lib/catalog";
import {
  categoryGroupIds,
  navCategories,
} from "@/lib/product";
import {
  buildShopTabs,
  filterShopProducts,
  resolveShopTreeState,
  shopHeading,
  shopTreeFailureNotice,
  shouldAllowRetry,
  truncatedCatalogLine,
} from "@/lib/shopPresentation";
import { emptyResultsMessage, searchResultsLine } from "@/lib/search";
import AsyncStateView from "@/components/AsyncState/AsyncState";
import ProductGrid from "../ProductsGrid/ProductGrid";

// F7 / G012 — the Filter type is no longer a hardcoded union of slugs. Tabs
// are derived from the authoritative GET /store/product-categories payload:
// "all" plus every top-level category (matched against its whole descendant
// group). An empty tree honestly renders only ALL.
//
// F9 / S1+E2 — all presentation decisions live in lib/shopPresentation.ts.
// A category-tree FAILURE is never rendered as success and never discarded:
// the view degrades to unscoped browsing WITH a visible notice and a retry
// affordance that re-runs ONLY the category-tree request (products stay
// cached). Rapid retry clicks are rate-limited by shouldAllowRetry; the
// in-flight run supersedes earlier ones (latest-wins) and unmount cancels.

type Filter = "all" | string;

export default function ShopView() {
   // useRouter lets us NAVIGATE.
   // useSearchParams lets us READ the URL's ?query.
  const router = useRouter();
  const params = useSearchParams();

  const { state, reload, total } = useCatalog();
  const { state: categoryState, reload: reloadCategories } = useCategoryTree();

  // F9/E2 — honest tree state: ready | loading | failed. An empty tree is a
  // usable truth (only ALL exists), not an error.
  const treeState = resolveShopTreeState(categoryState.status);

  const categories = useMemo(
    () =>
      categoryState.status === "success"
        ? navCategories(categoryState.data)
        : [],
    [categoryState],
  );

  const category = params.get("category") || "all";
  const query = params.get("q")?.toLowerCase() ?? "";

  const setCategory = (next: Filter) => {
    const sp = new URLSearchParams(params.toString());
    if (next === "all") sp.delete("category");
    else sp.set("category", next);

    // prevents the page from jumping back to the top
    router.push(`/shop?${sp.toString()}`, { scroll: false });
  };

  // F7 / G031 — an unknown ?category= slug is NOT silently reset to ALL; it
  // honestly yields zero matches with a message.
  const knownCategory =
    treeState === "ready" && category !== "all"
      ? categories.find((c) => c.slug === category) ?? null
      : null;

  // Tab list via the pure rule; while the tree is loading or failed the tab
  // bar degrades to ALL (+ the requested slug, kept visible) — never fake
  // categories, and the failure notice explains why.
  const tabs = useMemo(
    () =>
      buildShopTabs(
        treeState === "ready" ? categories : [],
        category,
      ),
    [treeState, categories, category],
  );

  // Whole-descendant-group matching (G012) only when the tree is usable;
  // otherwise scoping is impossible and stays null (query still applies).
  const groupIds = useMemo(() => {
    if (!knownCategory || categoryState.status !== "success") return null;
    return categoryGroupIds(knownCategory.id, categoryState.data);
  }, [knownCategory, categoryState]);

  const visible = useMemo(
    () =>
      filterShopProducts(state.status === "success" ? state.data : [], {
        groupIds,
        query,
      }),
    [state, groupIds, query],
  );

  // F9 — truncation honesty: when the server's total exceeds the loaded page,
  // say exactly what is shown. No pagination is invented.
  const truncationLine =
    state.status === "success"
      ? truncatedCatalogLine(state.data.length, total ?? 0)
      : null;

  // F9/S1 — tree-scoped retry with rapid-click protection. The last attempt
  // time lives in a ref (no timers scheduled → unmount-safe); clicks inside
  // the window are ignored because the in-flight run already supersedes them.
  const lastTreeRetryRef = useRef<number | null>(null);
  const onRetryCollections = useCallback(() => {
    if (!shouldAllowRetry(lastTreeRetryRef.current, Date.now())) return;
    lastTreeRetryRef.current = Date.now();
    reloadCategories();
  }, [reloadCategories]);

  // While a collection is selected but the tree has not loaded yet, scoping
  // cannot be decided — show that honestly instead of pretending ALL.
  const scopingPending = treeState === "loading" && category !== "all";

  // F10 — heading context from SERVER data only: a known category's real name
  // becomes the heading; ALL / unknown slug / loading / failure stay "SHOP
  // ALL" (pure rule in lib/shopPresentation.ts). Breadcrumb mirrors it so the
  // two can never disagree.
  const heading = shopHeading(knownCategory?.name ?? null);

  return (
   <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
      {/* --- Header block --- */}
      <div className="mb-6 md:mb-10">
        <div className="mb-2.5 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-3 md:text-[12px] md:tracking-[0.08em]">
          HOME / {heading}
        </div>
        <h1 className="mb-4 mt-0 font-display text-[28px] font-bold uppercase md:mb-5 md:text-[44px]">
          {heading}
        </h1>

        {/* F7 / G013 — honest search scope (pure rule in lib/search.ts): this
            filters the LOADED catalogue page, so the copy says so. */}
        {query && (
            <p className="mb-5 font-mono text-[12px] text-muted">
               {searchResultsLine(query, visible.length)} ·{" "}
                <button
                    type="button"
                    onClick={() => {
                        const sp = new URLSearchParams(params.toString());
                        sp.delete("q");
                        router.push(`/shop?${sp.toString()}`, { scroll: false})
                    }}
                    className="cursor-pointer border-none bg-transparent p-0 font-inherit text-ink underline"
               >
                Clear
                </button>
            </p>
        )}

        <div className="flex flex-wrap gap-2">
            {tabs.map((tab) => {
                const isActive = category === tab.key;
                return (
                    <button
                        key={tab.key}
                        type="button"
                        onClick={() => setCategory(tab.key)}
                        className={`cursor-pointer border border-ink px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.06em] md:px-7 md:py-3 md:text-[12px] md:tracking-[0.08em] ${
                            isActive
                                ? "bg-ink text-paper-2"
                                : "bg-transparent text-ink hover:opacity-70"
                        }`}
                      >
                      {tab.label}
                    </button>
                )
            })}
        </div>

        {/* F9 — truncation honesty: the loaded page may be a prefix of the
            full result set; the copy states exactly what is shown. */}
        {truncationLine && (
          <p className="mt-4 mb-0 font-mono text-[11px] leading-relaxed text-muted md:text-[12px]">
            {truncationLine}
          </p>
        )}

        {/* F9/S1 — a failed category-tree request stays visible with a retry
            affordance scoped to ONLY the category-tree request. */}
        {treeState === "failed" && (
          <div className="mt-4 flex flex-col items-start gap-3">
            <p className="m-0 font-mono text-[11px] leading-relaxed text-muted md:text-[12px]">
              {shopTreeFailureNotice(category !== "all")}
            </p>
            <button
              type="button"
              onClick={onRetryCollections}
              className="cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
            >
              RETRY COLLECTIONS
            </button>
          </div>
        )}
      </div>
        {/* The filtered grid */}
        <AsyncStateView
            state={state}
            loadingLabel="LOADING CATALOG"
            emptyLabel="The catalogue is empty."
            onRetry={reload}
        >
            {() =>
              scopingPending ? (
                <p className="font-mono text-[12px] leading-relaxed text-muted">
                  LOADING COLLECTIONS…
                </p>
              ) : visible.length > 0 ? (
                <ProductGrid products={visible} />
              ) : (
                /* F7 / G031 — honest zero-results message (pure rule in
                   lib/search.ts) instead of a bare grid. */
                <p className="font-mono text-[12px] leading-relaxed text-muted">
                  {emptyResultsMessage({
                    query,
                    categoryName: knownCategory?.name ?? null,
                  })}
                </p>
              )
            }
        </AsyncStateView>
      </section>
)
}
