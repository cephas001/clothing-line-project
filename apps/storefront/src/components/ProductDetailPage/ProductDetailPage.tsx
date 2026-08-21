// apps/storefront/src/components/ProductDetailPage/ProductDetailPage.tsx
//
// Client-side product page container. F7.1 / G018: data comes from the
// dedicated useProductDetail hook — the slug resolves against the shared
// browse list for fast paint and is then upgraded by an authoritative
// GET /store/products/{id} fetch (latest-wins guarded), so the PDP no longer
// depends exclusively on the cached browse list. A missing/unknown product
// renders an inline not-found state (notFound() is server-only, so the client
// shows a clear path back to /shop). Related products come from the
// same-category fallback — the backend /related endpoint is not wired.

"use client";

import Link from "next/link";
import { useProductDetail } from "@/lib/catalog";
import { pdpTruncationNotice } from "@/lib/shopPresentation";
import AsyncStateView from "@/components/AsyncState/AsyncState";
import ProductDetail from "@/components/ProductDetail/ProductDetail";

export default function ProductDetailPage({ slug }: { slug: string }) {
  const { state, reload } = useProductDetail(slug);

  return (
    <AsyncStateView
      state={state}
      loadingLabel="LOADING PRODUCT"
      emptyLabel="The catalogue is empty."
      onRetry={reload}
    >
      {(data) => {
        if (!data.product) {
          return (
            <section className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 text-center">
              <div className="font-mono text-[11px] tracking-[0.1em] text-muted">
                [ PRODUCT NOT FOUND ]
              </div>
              <h1 className="m-0 font-display text-[clamp(32px,7vw,72px)] font-black uppercase leading-[0.95]">
                NOTHING HERE.
              </h1>
              <Link
                href="/shop"
                className="cursor-pointer border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
              >
                BACK TO SHOP
              </Link>
            </section>
          );
        }
        // F10 — truncation honesty: when the browse list behind related items
        // and slug resolution is a known prefix of the catalogue, say so.
        const truncationNotice = pdpTruncationNotice({
          catalogTruncated: data.catalogTruncated,
          shownCount: data.catalogShown,
          totalCount: data.catalogTotal,
        });
        return (
          <>
            {truncationNotice && (
              <p className="px-4 pt-4 font-mono text-[11px] leading-relaxed text-muted md:px-8 md:text-[12px]">
                {truncationNotice}
              </p>
            )}
            <ProductDetail
              product={data.product}
              related={data.related}
              detailUnavailable={data.detailError}
            />
          </>
        );
      }}
    </AsyncStateView>
  );
}
