"use client";

import Link from "next/link";
import Image from "next/image";
import logo from "@/assets/logo.png"
import { useCategoryTree } from "@/lib/catalog";
import { navCategories } from "@/lib/product";

export default function Footer() {
    // F7 / G012 — the SHOP column is derived from the authoritative category
    // payload (same cached fetch as the Header). An empty tree honestly
    // renders only SHOP ALL.
    const { state: categoryState } = useCategoryTree();
    const categories =
      categoryState.status === "success" ? navCategories(categoryState.data) : [];

    return (
      <footer className="bg-ink px-4 pb-8 pt-10 text-paper-2 md:px-8 md:pb-8 md:pt-16">
        {/* F7/G021+G022: the dead HELP links (href="#") and the generic social
            links were removed — no real content pages or project-owned social
            URLs exist to route them to. */}
        <div className="mb-8 grid grid-cols-2 gap-8 md:mb-12 md:grid-cols-3 md:gap-10">
          {/* Brand column */}
           <div className="col-span-2 md:col-span-1">
              <Image
                src={logo}
                alt="QUHÁ logo"
                width={120}        
                height={28}
                priority          
                className="h-5 w-auto md:h-6" 
              />
              <p className="m-0 max-w-[240px] font-display text-[12px] leading-relaxed mt-2 text-muted-2 md:text-[13px]">
                Raw materials, hard edges. Small-batch drops, no restocks.
              </p>
            </div> 

            {/* Shop column */}
            <div>
              <div className="mb-3 font-mono text-[10px] tracking-[0.08em] text-muted-2 md:mb-4 md:text-[11px]">
                SHOP
              </div>
              <div className="flex flex-col gap-2.5">
                <Link href="/shop" className="font-display text-[13px] hover:opacity-60 text-paper-2">SHOP ALL</Link>
                {categories.map((category) => (
                  <Link
                    key={category.id}
                    href={`/shop?category=${category.slug}`}
                    className="font-display text-[13px] hover:opacity-60 text-paper-2"
                  >
                    {category.name.toUpperCase()}
                  </Link>
                ))}
              </div>
           </div> 

           {/* About column */}
           <div>
              <div className="mb-3 font-mono text-[10px] tracking-[0.08em] text-muted-2 md:mb-4 md:text-[11px]">
                BRAND
              </div>
              <div className="flex flex-col gap-2.5">
                <Link href="/about" className="font-display text-[13px] text-paper-2 hover:opacity-60">ABOUT</Link>
              </div>
           </div> 
        </div>

        {/* Bottom bar — F7/G028: text-muted-2 keeps 7:1 contrast on ink
            (text-muted failed AA at this size on the dark background). */}
        <div className="flex flex-wrap justify-between gap-4 border-t border-[#2b2b2b] pt-6 font-mono text-[11px] tracking-[0.04em] text-muted-2">
          <span>© {new Date().getFullYear()} QUHÁ</span>
          <span>© [ LOUD IN SILENCE ]</span>
        </div>
      </footer>  
    )
}