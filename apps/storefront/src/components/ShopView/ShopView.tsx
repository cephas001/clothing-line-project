"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ProductView, CategorySlug } from "@/lib/types";
import ProductGrid from "../ProductsGrid/ProductGrid";
import { button } from "framer-motion/client";

interface ShopViewProps {
  products: ProductView[];
}

// Filter can be either "all" or a real category slug.
type Filter = "all" | CategorySlug;

// The tabs at the top. key is the URL value; label is what the button shows.
const TABS: { key: Filter; label: string }[] = [
    { key: "all", label: 'ALL' },
    { key: "jackets", label: 'JACKETS' },
    { key: "jewelry", label: 'JEWELRY' },
    { key: "accessories", label: 'ACCESSORIES' },
    { key: "off-duties", label: 'OFF-DUTIES' },
];

export default function ShopView({ products }: ShopViewProps) {
   // useRouter lets us NAVIGATE. 
   // useSearchParams lets us READ the URL's ?query. 
  const router = useRouter();
  const params = useSearchParams();

    // Looks for ?category=... in the URL
    // as Filter, this tells TypeScript to treat the value as a Filter type
    // default to "all" if there's no category
  const category = (params.get("category") as Filter) || "all";

  // looks for ?q=... in the URL
  // ?? "", if there’s no search term, use an empty string ""
  const query = params.get("q")?.toLowerCase() ?? "";

  // This function updates the category in the URL when a user clicks a filter
  const setCategory = (next: Filter) => {
    // Creates a copy of the current search params so they can be safely modified.
    const sp = new URLSearchParams(params.toString());
    if (next === "all") sp.delete("category");
    else sp.set("category", next);

    // prevents the page from jumping back to the top
    router.push (`/shop?${sp.toString()}`, { scroll: false });
  };

  const visible = useMemo(() => {
    let list = products;
    if (category !== "all") {
        list = list.filter((p) => p.category === category)
    }
    if (query) list = list.filter((p) => p.name.toLowerCase().includes(query))
        return list;
  }, [products, category, query]);

  return (
   <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
      {/* --- Header block --- */}
      <div className="mb-6 md:mb-10">
        <div className="mb-2.5 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-3 md:text-[12px] md:tracking-[0.08em]">
          HOME / SHOP ALL
        </div>
        <h1 className="mb-4 mt-0 font-display text-[28px] font-bold uppercase md:mb-5 md:text-[44px]">
          SHOP ALL
        </h1>

        {query && (
            <p className="mb-5 font-mono text-[12px] text-muted">
               Results for &ldquo;{query}&rdquo; ·{" "}
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
            {TABS.map((tab) => {
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
      </div>
        {/* The filtered grid */}
        <ProductGrid products={visible} />
      </section>
)
}
