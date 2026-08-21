// apps/storefront/src/lib/catalog.ts
//
// Catalog data hooks for client components. All reads go through the shared
// API client (src/lib/api/catalog.ts); the results are projected to UI views
// via src/lib/product.ts. Loading/Success/Empty/Error states come from the
// central AsyncState model.
//
// F7.1 / G017+G018: the PDP no longer depends exclusively on the cached
// browse list — useProductDetail resolves the slug against the browse list
// (fast paint) and then upgrades to a dedicated GET /store/products/{id}
// fetch, guarded by latest-wins tickets so a stale response can never
// overwrite a newer one.
//
// Both hooks follow the same discipline: state is ONLY written from async
// callbacks (never synchronously in an effect body), and each result carries
// the identity of the run/selection that produced it. Staleness is derived
// during render — an outdated result simply is not shown.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VariantAvailability, Category } from "@clothing-line-project/shared-types";
import {
  clearCatalogCache,
  clearCategoriesCache,
  getCatalog,
  getProduct,
  getVariantAvailability,
  listCategoriesCached,
} from "./api/catalog";
import { createLatestWinsGuard } from "./availability";
import { useAsyncData, type AsyncState, type UseAsyncDataResult } from "./async";
import { isApiError, normalizeApiError } from "./api/errors";
import {
  categorySlugOf,
  findBySlug,
  relatedProducts,
  toProductView,
  toProductViews,
} from "./product";
import type { ProductView } from "./types";

export interface UseCatalogResult {
  state: UseAsyncDataResult<ProductView[]>["state"];
  reload: () => void;
  /**
   * F9 — the server's total matching count for the browse list, when a
   * successful payload is loaded; null otherwise. When `total` exceeds
   * `state.data.length` the loaded page is TRUNCATED and callers must say so
   * (see lib/shopPresentation.ts truncatedCatalogLine). Never fabricated.
   */
  total: number | null;
}

/**
 * Load the browse list + category tree once and project them to ProductViews.
 * Components on the same page share one cached fetch; reload busts the cache.
 * The server's total travels with the projection so truncation stays visible.
 */
export function useCatalog(): UseCatalogResult {
  const result = useAsyncData<{ views: ProductView[]; total: number }>(
    async () => {
      const { products, categories, total } = await getCatalog();
      return { views: toProductViews(products, categories), total };
    },
    [],
  );

  const reload = () => {
    clearCatalogCache();
    result.reload();
  };

  // Preserve the established AsyncState<ProductView[]> contract for consumers
  // (including the empty-array → "empty" conversion) while carrying the
  // server's total alongside it.
  const state: UseAsyncDataResult<ProductView[]>["state"] =
    result.state.status === "success"
      ? result.state.data.views.length === 0
        ? { status: "empty" }
        : { status: "success", data: result.state.data.views }
      : result.state;

  const total =
    result.state.status === "success" ? result.state.data.total : null;

  return { state, reload, total };
}

/** Everything the PDP renders, resolved by useProductDetail. */
export interface ProductDetailData {
  /**
   * The product view: the dedicated detail fetch when available, else the
   * browse-list projection (fast paint). Null when the slug is unknown —
   * the page renders its not-found state.
   */
  product: ProductView | null;
  /** Same-category fallback items for "You may also like". */
  related: ProductView[];
  /**
   * G019 / F10: true when the browse list is TRUNCATED (the server's total
   * exceeds the fetched page, which already uses the contract-max limit of
   * 200). Callers must not treat the list as complete — and now SAY so via
   * pdpTruncationNotice (lib/shopPresentation.ts).
   */
  catalogTruncated: boolean;
  /**
   * F10: how many products the loaded browse page holds and what the server
   * reports as its total — the two numbers behind the truncation notice.
   * Both come verbatim from the catalog payload; never computed.
   */
  catalogShown: number;
  catalogTotal: number;
  /**
   * F8: true when the authoritative GET /store/products/{id} upgrade FAILED.
   * The rendered product is still real server data (the browse projection) —
   * never fabricated — but the page says so instead of staying silent, so a
   * stale/truncated snapshot is never mistaken for live detail data.
   */
  detailError: boolean;
}

/**
 * F7.1 / G018 — dedicated PDP data hook, two layers:
 *
 * Layer 1 (fast paint): the shared, cached browse list resolves the slug and
 * renders immediately; loading/error pass through unchanged and an unknown
 * slug surfaces as `product: null`.
 *
 * Layer 2 (authoritative): once the id is known, GET /store/products/{id}
 * refreshes the projection with fresh server data. Best-effort by design —
 * on failure the browse projection remains (graceful degradation, never a
 * fake). Every run takes latest-wins tickets: a slow older response can
 * never overwrite a newer run's data after a slug change or reload.
 *
 * State writes happen only inside async callbacks; while a run is in flight
 * the rendered state is derived as `loading` by comparing the completed
 * result's run key with the current one (no cascading sync setState).
 */
export function useProductDetail(slug: string): {
  state: AsyncState<ProductDetailData>;
  reload: () => void;
} {
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // The latest COMPLETED result, tagged with the run that produced it.
  const [completed, setCompleted] = useState<{
    key: number;
    state: AsyncState<ProductDetailData>;
  }>(() => ({ key: -1, state: { status: "loading" } }));

  const guardRef = useRef(createLatestWinsGuard());
  useEffect(() => {
    let cancelled = false;
    const catalogTicket = guardRef.current.start();

    getCatalog()
      .then(({ products, categories, total }) => {
        if (cancelled || !guardRef.current.isActive(catalogTicket)) return;

        const views = toProductViews(products, categories);
        const listed = findBySlug(views, slug) ?? null;
        const data: ProductDetailData = {
          product: listed,
          related: listed ? relatedProducts(views, listed) : [],
          catalogTruncated: total > products.length,
          catalogShown: products.length,
          catalogTotal: total,
          detailError: false,
        };
        // Layer 1 lands immediately (fast paint).
        setCompleted({
          key: version,
          state: { status: "success", data },
        });

        // Layer 2: authoritative refresh from the dedicated detail endpoint.
        if (!listed) return;
        const detailTicket = guardRef.current.start();
        getProduct(listed.id)
          .then((dto) => {
            if (cancelled || !guardRef.current.isActive(detailTicket)) return;
            setCompleted({
              key: version,
              state: {
                status: "success",
                data: {
                  ...data,
                  product: toProductView(dto, categorySlugOf(listed.category)),
                },
              },
            });
          })
          .catch(() => {
            // F8: best-effort upgrade — the browse projection REMAINS (it is
            // real server data, never a fabrication), but the failure is
            // surfaced so the page can say the live details are unavailable.
            if (cancelled || !guardRef.current.isActive(detailTicket)) return;
            setCompleted({
              key: version,
              state: {
                status: "success",
                data: { ...data, detailError: true },
              },
            });
          });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCompleted({
          key: version,
          state: {
            status: "error",
            error: isApiError(error) ? error : normalizeApiError(error),
          },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [slug, version]);

  // Derived staleness: a result from an older run renders as loading.
  const state =
    completed.key === version
      ? completed.state
      : ({ status: "loading" } as AsyncState<ProductDetailData>);

  return { state, reload };
}

/**
 * F7 / G012 — the authoritative category tree for navigation (Header, Shop,
 * Footer). Reads the independently cached category-tree request, so using
 * both hooks on one page still costs NO extra network traffic (getCatalog
 * populates the same cache slot).
 *
 * F9 / S1 — reload() busts ONLY the category-tree cache: a tree failure is
 * retried without refetching products. Rapid clicks are safe — each click
 * bumps the run version and every in-flight run is superseded by the next
 * (latest-wins via useAsyncData's cancelled flags); unmount cancels cleanly.
 */
export function useCategoryTree(): {
  state: AsyncState<Category[]>;
  reload: () => void;
} {
  const result = useAsyncData<Category[]>(
    async () => await listCategoriesCached(),
    [],
  );

  const reload = useCallback(() => {
    clearCategoriesCache();
    result.reload();
  }, [result]);

  return { state: result.state, reload };
}

/**
 * F7.1 / G017 — live availability for the SELECTED variant.
 *
 * Fetches GET /store/variants/{id}/availability whenever the selection
 * changes and exposes the freshest server answer. The answer is tagged with
 * the variant that requested it, so a slow older response can never be
 * mistaken for the current selection's data (derived at render — no sync
 * resets, no out-of-order application). Failures are swallowed: the live
 * check upgrades the already-rendered server data, it is never a requirement.
 */
export function useVariantAvailability(
  variantId: string | null,
): VariantAvailability | null {
  const [answer, setAnswer] = useState<{
    variantId: string;
    dto: VariantAvailability;
  } | null>(null);

  const guardRef = useRef(createLatestWinsGuard());
  useEffect(() => {
    if (!variantId) return;
    let cancelled = false;
    const ticket = guardRef.current.start();
    getVariantAvailability(variantId)
      .then((dto) => {
        if (cancelled || !guardRef.current.isActive(ticket)) return;
        setAnswer({ variantId, dto });
      })
      .catch(() => {
        // Best-effort live check; the PDP keeps its current truthful data.
      });
    return () => {
      cancelled = true;
    };
  }, [variantId]);

  return answer && answer.variantId === variantId ? answer.dto : null;
}
