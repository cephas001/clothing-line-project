"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useWishlist } from "@/context/WishlistContext";
import { getAllProducts } from "@/lib/product";
import ProductGrid from "../ProductsGrid/ProductGrid";

export default function WishlistView() {
  const { items } = useWishlist();

  const allProducts = getAllProducts();
  const savedProducts = allProducts.filter((p) => items.includes(p.id))

  if(savedProducts.length === 0){
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

      <motion.h1
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
        className="mb-8 mt-0 font-display text-[28px] font-bold uppercase md:mb-12 md:text-[44px]"
      >
        WISHLIST ({savedProducts.length})
      </motion.h1>

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.16, ease: [0.16, 1, 0.3, 1] }}
      >
        <ProductGrid products={savedProducts} />
      </motion.div>
    </section>
  )
  
  };



  