"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Plus, Heart } from "lucide-react";
import type { ProductView } from "@/lib/types";
import { useCart } from "@/context/CartContext";
import { useWishlist } from "@/context/WishlistContext";
import { useCurrency } from "@/context/CurrencyContext";
import ProductImage from "../ProductImage/ProductImage";


// This tells TypeScript what props the component acceptsIt must be a number if provided.
interface ProductCardProps {
  product: ProductView;
  index?: number;
}
// Destructure product and index from the props.
export default function ProductCard({ product, index = 0 }: ProductCardProps) {
    // Custom hook
  const { addToCart } = useCart();
  const { format } = useCurrency();  
  const { toggle, isSaved } = useWishlist();
  const saved = isSaved(product.id);

  // Tenary operator for displaying the product status
  const statusLabel = 
    product.isSoldOut
        ? "SOLD OUT"
        : product.sellingFast
        ? "SELLING FAST"
        : null;

    const handleQuickAdd = (e: React.MouseEvent) => {
        // stops the browser’s default action
        e.preventDefault();
        // tops the click from bubbling up to parent elements
        e.stopPropagation();   
        if (product.isSoldOut) return;

        // Looks through all the product’s variants and finds the first one that is still available.
        // If none are available, exit early.
        const firstAvailable = product.variants.find((v) => v.available);
        if (!firstAvailable) return;

        addToCart(product, firstAvailable.id);
    }
    return (
        <motion.article
            className="bg-paper"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-40px" }}
            transition={{ duration: 0.4, delay: index * 0.06, ease: [0.16, 1, 0.3, 1] }}
            whileHover="hover"
        >
            <Link href={`/product/${product.slug}`} className="block text-ink hover:opacity-100">
                <div className="relative aspect-[4/5] overflow-hidden bg-placeholder">
                    <ProductImage
                        src={product.images.studio}
                        alt={product.name}
                        label={product.name.split(" ")[0].toUpperCase()}
                    />
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggle(product.id);
                        }}
                        aria-label={saved ? "Remove from wishlist" : "Save to wishlist"}
                        className={`absolute right-3 top-3 z-[2] flex h-8 w-8 items-center justify-center transition ${
                            saved ? "bg-ink text-paper" : "bg-ink/70 text-paper hover:bg-ink"
                            }`}
                    >
                        <Heart
                            size={16}
                            strokeWidth={1.75}
                            fill={saved ? "currentColor" : "none"}
                        />
                    </button>
                    {statusLabel && (
                    <span className="absolute left-3 top-3 z-[2] bg-ink px-[9px] py-[5px] font-mono text-[10px] tracking-[0.06em] text-paper">{statusLabel}</span>
                    )}

                    {!product.isSoldOut && (
                    <motion.button
                            type="button"
                            onClick={handleQuickAdd}
                            aria-label={`Add ${product.name} to cart`}
                            className="absolute bottom-3 right-3 z-[2] flex items-center gap-1.5 bg-ink px-[13px] py-[9px] font-mono text-[11px] tracking-[0.08em] text-paper hover:bg-paper hover:text-ink hover:shadow-[inset_0_0_0_1px_theme(colors.ink)]"
                            initial={{ opacity: 0, y: 8 }}
                            variants={{ hover: { opacity: 1, y: 0 } }}                      
                    >
                        <Plus size={16} strokeWidth={1.75} />
                        <span>ADD</span>
                    </motion.button> 
                    )}
                </div>

                <div className="flex items-baseline justify-between gap-3 px-1 pb-1 pt-3.5">
                <h3 className="m-0 font-display text-[13px] font-semibold uppercase leading-tight tracking-[0.01em]">
                    {product.name}
                    </h3>
                    <span className="whitespace-nowrap font-mono text-[13px]">
                        {product.priceAmount > 0 
                            ? format(product.priceAmount, product.currencyCode)
                        : "-"}
                    </span>
                </div>
            </Link>
        </motion.article>
    )
}