"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useMemo } from "react";
import { useWishlist } from "@/context/WishlistContext";
import { useCatalog } from "@/lib/catalog";
import {
  missingWishlistNotice,
  presentMissingWishlistItem,
  projectWishlist,
  wishlistContentState,
} from "@/lib/wishlistProjection";
import ProductGrid from "../ProductsGrid/ProductGrid";

// F9 / E5 + F8-W1 — the wishlist is projected through lib/wishlistProjection.ts:
// saved ids, resolved products and missing ids stay DISTINCT. A saved id that
// no longer resolves is never silently dropped — it is listed as unavailable
// (authoritative absence from a complete catalogue) or unresolved (the loaded
// catalogue page is truncated), each with an explicit REMOVE affordance.

export default function WishlistView() {
  const { items, toggle } = useWishlist();
  const { state, reload, total } = useCatalog();

  // Completeness comes from the server's total: only a page that IS the whole
  // result set may claim an item is gone; otherwise it is "unresolved".
  const catalogComplete =
    state.status === "success" && total !== null
      ? state.data.length >= total
      : false;

  const projection = useMemo(
    () =>
      state.status === "success"
        ? projectWishlist({
            savedIds: items,
            catalog: state.data,
            catalogComplete,
          })
        : null,
    [state, items, catalogComplete],
  );

  if (state.status !== "success" || projection === null) {
    return (
      <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
        <div className="mb-6 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-8 md:text-[12px]">
          HOME / WISHLIST
        </div>
        <div className="flex min-h-[30vh] flex-col items-center justify-center gap-5">
          {state.status === "error" ? (
            <>
              <span className="font-mono text-[11px] tracking-[0.1em] text-muted">
                {state.error.message}
              </span>
              <button
                type="button"
                onClick={reload}
                className="cursor-pointer border border-ink bg-transparent px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
              >
                TRY AGAIN
              </button>
            </>
          ) : (
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
              LOADING WISHLIST…
            </span>
          )}
        </div>
      </section>
    );
  }

  const contentState = wishlistContentState(projection);

  if (contentState === "empty") {
    return (
       <section className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-4 text-center md:px-8">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="font-mono text-[11px] tracking-[0.1em] text-muted md:text-[12px]"
        >
            [ EMPTY ]
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
          className="m-0 font-display text-[clamp(40px,9vw,96px)] font-black uppercase leading-[0.95]"
        >
          NOTHING SAVED.
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-md font-display text-[14px] text-muted md:text-[15px]"
        >
          Tap the heart on any product to save it here for later.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.24, ease: [0.16, 1, 0.3, 1] }}
        >
          <Link
            href="/shop"
            className="inline-block border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:!bg-ink hover:!text-paper-2 hover:!opacity-100 md:px-8 md:py-4 md:text-[12px]"
          >
            BROWSE SHOP
          </Link>
        </motion.div>
       </section>
    )
  }

  const unavailableNotice = missingWishlistNotice(
    projection.missing.filter((m) => m.reason === "unavailable").length,
    "unavailable",
  );
  const unresolvedNotice = missingWishlistNotice(
    projection.missing.filter((m) => m.reason === "unresolved").length,
    "unresolved",
  );

  return (
    <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
        <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="mb-6 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-8 md:text-[12px]"
      >
        HOME / WISHLIST
      </motion.div>

      {/* The count names SAVED items — resolved and missing alike — so a
          removed-from-catalogue product never silently shrinks the list. */}
      <motion.h1
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
        className="mb-8 mt-0 font-display text-[28px] font-bold uppercase md:mb-12 md:text-[44px]"
      >
        WISHLIST ({projection.savedIds.length})
      </motion.h1>

      {projection.resolved.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.16, ease: [0.16, 1, 0.3, 1] }}
        >
          <ProductGrid products={projection.resolved} />
        </motion.div>
      )}

      {(contentState === "none-available" ||
        contentState === "partially-available") && (
        <div
          className={`flex flex-col gap-4 ${
            contentState === "partially-available" ? "mt-10" : ""
          }`}
        >
          {contentState === "none-available" && (
            <p className="m-0 font-mono text-[12px] leading-relaxed text-muted">
              None of your saved items could be shown right now.
            </p>
          )}
          {unavailableNotice && (
            <p className="m-0 font-mono text-[11px] leading-relaxed text-muted md:text-[12px]">
              {unavailableNotice}
            </p>
          )}
          {unresolvedNotice && (
            <p className="m-0 font-mono text-[11px] leading-relaxed text-muted md:text-[12px]">
              {unresolvedNotice}
            </p>
          )}
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {projection.missing.map((item) => {
              // F10 — presentation hierarchy (lib/wishlistProjection.ts): a
              // known title would lead; without one the id is shown ONLY as a
              // labelled REF line — never dressed up as a product name. No
              // per-id fetching happens here.
              const missing = presentMissingWishlistItem(item);
              return (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-4 border border-muted/40 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="font-display text-[13px] font-semibold uppercase md:text-[14px]">
                      {missing.heading}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-muted">
                      {missing.statusLabel}
                    </div>
                    {missing.diagnosticId && (
                      <div className="mt-0.5 truncate font-mono text-[9px] uppercase tracking-[0.06em] text-muted">
                        REF {missing.diagnosticId.toUpperCase()}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(item.id)}
                    className="shrink-0 cursor-pointer border border-ink bg-transparent px-4 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink hover:bg-ink hover:text-paper-2"
                  >
                    REMOVE
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
