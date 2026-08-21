// apps/storefront/src/components/HomeView/HomeView.tsx
//
// F9 / E1 + F8-H1/H2 — home catalog sections derived ENTIRELY from
// authoritative projections (lib/homeSections.ts): the server category tree
// names and orders the sections; the region-scoped browse list fills them.
// No category slug, name, or order is hardcoded anymore.
//
// Honest degradation matrix:
//   - catalog loading/error/empty -> central AsyncStateView (unchanged).
//   - tree loading                -> "LOADING COLLECTIONS…" (no fake sections).
//   - tree error                  -> notice + full browse grid under BROWSE ALL
//                                    (no invented collection names).
//   - tree empty                  -> "no collections published" + browse grid.
//   - populated section           -> product grid.
//   - empty section               -> "nothing here yet" message — NEVER a
//                                    "sold out" claim (server provides no such
//                                    category-level state).

"use client";

import Link from "next/link";
import { useCatalog, useCategoryTree } from "@/lib/catalog";
import {
  buildHomeSections,
  sectionContentState,
} from "@/lib/homeSections";
import AsyncStateView from "@/components/AsyncState/AsyncState";
import ProductGrid from "@/components/ProductsGrid/ProductGrid";
import Hero from "@/components/Hero/Hero";
import Marquee from "@/components/Marquee/Marquee";

const FIRST_SECTION_CLASS = "px-4 pt-8 pb-4 md:px-8 md:pt-20 md:pb-10";
const SECTION_CLASS = "px-4 pt-4 pb-14 md:px-8 md:pt-4 md:pb-24";

export default function HomeView() {
  const { state, reload } = useCatalog();
  // Same cached payload as useCatalog (one shared fetch); projects the tree.
  const { state: categoryState } = useCategoryTree();

  return (
    <>
      <Hero />
      <Marquee />
      <AsyncStateView
        state={state}
        loadingLabel="LOADING CATALOG"
        emptyLabel="The catalogue is empty."
        onRetry={reload}
      >
        {(products) => {
          if (categoryState.status === "loading") {
            return (
              <section className={FIRST_SECTION_CLASS}>
                <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                  LOADING COLLECTIONS…
                </span>
              </section>
            );
          }

          if (categoryState.status === "error") {
            // The tree is unavailable: no section may be invented. The full
            // browse list stays reachable under an honest notice.
            return (
              <section className={FIRST_SECTION_CLASS}>
                <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted md:mb-8">
                  COLLECTIONS ARE TEMPORARILY UNAVAILABLE — SHOWING EVERYTHING.
                </p>
                <ProductGrid products={products} />
              </section>
            );
          }

          const categories =
            categoryState.status === "success" ? categoryState.data : [];
          if (categories.length === 0) {
            return (
              <section className={FIRST_SECTION_CLASS}>
                <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted md:mb-8">
                  NO COLLECTIONS PUBLISHED YET — SHOWING EVERYTHING.
                </p>
                <ProductGrid products={products} />
              </section>
            );
          }

          const sections = buildHomeSections(categories, products);
          return (
            <>
              {sections.map((section) => {
                const content = sectionContentState(section.items);
                return (
                  <section
                    key={section.key}
                    className={
                      section.index === "01"
                        ? FIRST_SECTION_CLASS
                        : SECTION_CLASS
                    }
                  >
                    <div className="mb-5 flex items-baseline justify-between gap-4 md:mb-8">
                      <div>
                        <div className="mb-1.5 font-mono text-[10px] tracking-[0.1em] text-muted md:mb-2 md:text-xs">
                          [ {section.index} — {section.label.toUpperCase()} ]
                        </div>
                        <h2 className="m-0 font-display text-[22px] font-bold uppercase md:text-4xl">
                          {section.label}
                        </h2>
                      </div>
                      <Link
                        href={section.href}
                        className="whitespace-nowrap font-mono text-[10px] tracking-[0.08em] underline md:text-xs"
                      >
                        VIEW ALL
                      </Link>
                    </div>
                    {content === "populated" ? (
                      <ProductGrid products={section.items} />
                    ) : (
                      <p className="font-mono text-[12px] text-muted">
                        Nothing in this collection yet.
                      </p>
                    )}
                  </section>
                );
              })}
            </>
          );
        }}
      </AsyncStateView>
    </>
  );
}
