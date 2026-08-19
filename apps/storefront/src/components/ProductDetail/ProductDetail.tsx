"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ProductView } from "@/lib/types";
import { useCart } from "@/context/CartContext";
import { useCurrency } from "@/context/CurrencyContext";
import ProductImage from "../ProductImage/ProductImage";
import ProductAccordions from "./ProductAccordions"
import RelatedProducts from "./RelatedProducts"


interface ProductDetailProps {
  product: ProductView;
  related: ProductView[];
}

export default function ProductDetail({ product, related }: ProductDetailProps) {
  const { addToCart } = useCart();
  const { format } = useCurrency();

  // Keeps track of which product image is currently showing
  // 0 is studio image
  // 1 is styled image
  const [activeImg, setActiveImg] = useState<0 | 1>(0);

    // This sets the initially selected size/variant.
    // Finds the first available one
    // Uses its id as the starting selection
    // If nothing is available, it becomes null
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    product.variants.find((v) => v.available)?.id ?? null
  );

  // From the ID stored in state, this finds the full variant object.
  const selectedVariant = product.variants.find((v) => v.id === selectedVariantId);
  const statusLabel = product.isSoldOut
        ? "SOLD OUT"
        : product.sellingFast
        ? "SELLING FAST"
        : null;

    // Creates an array of the two product images
    // Creates matching labels for the image switcher buttons
    const images = [product.images.studio, product.images.styled];
    const labels = ["STUDIO", "STYLED"];

    const handleAddToCart = () => {
        if(!selectedVariantId || product.isSoldOut) return;
        addToCart(product, selectedVariantId)
    };

    return (
       <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
        <div className="mb-6 break-words font-mono text-[10px] tracking-[0.06em] text-muted md:mb-8 md:text-[12px]">
            HOME / {product.category.toUpperCase()} / {product.name.toUpperCase()}
        </div>
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[1.1fr_1fr] md:gap-16">
          {/*  LEFT: image gallery  */}
            <div>
               <div className="relative mb-3 aspect-[4/5] overflow-hidden bg-placeholder">
                  <AnimatePresence mode="wait">
                    <motion.div
                        key={activeImg}  
                        className="absolute inset-0"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                    >
                       <ProductImage
                          src={images[activeImg]}
                          alt={`${product.name} - ${labels[activeImg]}`}
                          label={labels[activeImg]}
                          sizes="(max-width: 768px) 100vw, 55vw"
                          priority
                       /> 
                    </motion.div>
                  </AnimatePresence>  
               </div> 
               {/* Thumbnails */}
               <div className="grid grid-cols-2 gap-2">
                {images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveImg(i as 0 | 1)}
                  aria-label={`View ${labels[i]} image`}
                  className={`relative aspect-square cursor-pointer overflow-hidden border border-ink bg-paceholder p-0 ${
                    activeImg === i ? "outline outline-2 outline-offset-2 outline-ink" : ""
                  }`}
                  >
                    <ProductImage src={src} alt={labels[i]} label={labels[i]} sizes="200px" />
                  </button>                  
                ))}
               </div>
            </div>
            {/*  RIGHT: info + variants + add to cart  */}
            <div>
              <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.08em] text-muted md:text-[12px]">
                {product.category} / {selectedVariant?.sku ?? product.variants[0]?.sku ?? "-"}
              </div>

              <h1 className="mb-3 mt-0 font-display text-[22px] md:mb-4 md:text-[28px] md:leading-[1.15] font-bold uppercase eading-tight">
                {product.name}
              </h1>

              <div className="mb-4 font-mono text-[17px] md:mb-5 md:text-[20px]">
                {product.priceAmount > 0
                  ? format(product.priceAmount, product.currencyCode)
                  : "-"}
              </div>

              {/* Status Badge */}
              {statusLabel && (
                <div className="mb-4 inline-block bg-ink px-2.5 py-1.5 font-mono text-[10px] tracking-[0.05em] text-paper-2 md:mb-5 md:text-[11px] md:tracking-[0.06em]">
                  {statusLabel}
                </div>
              )}

             <div className="my-4 border-t border-line-soft md:my-6" />

              {product.variants.length > 1 && (
                <div className="mb-5 md:mb-7">
                  <div className="mb-2 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-2.5 md:text-[11px] md:tracking-[0.08em]">SIZE</div>
                  <div className="flex flex-wrap gap-1.5 md:gap-2">
                    {product.variants.map((v) => {
                      const isSelected = v.id === selectedVariantId;
                      return(
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => v.available && setSelectedVariantId(v.id)}
                          disabled={!v.available}
                          className={`min-w-[40px] cursor-pointer border border-ink px-3 py-2.5 font-mono text-[11px] md:min-w-[44px] md:px-3.5 md:py-2.5 md:text-[12px] ${
                            isSelected
                              ? "bg-ink text-paper-2"
                              : "bg-transparent text-ink"
                          } ${!v.available ? "cursor-not-allowed !text-muted line-through opacity-50" : ""}`}
                         >
                          {v.label}
                         </button>
                      )
                    })}
                  </div>
                </div>
              )} 
              {/* Add to cart */}
              <button
                type="button"
                onClick={handleAddToCart}
                disabled={product.isSoldOut || !selectedVariantId}
                className="h-[50px] w-full cursor-pointer border-none bg-ink font-mono text-[12px] uppercase tracking-[0.08em] text-paper-2 hover:!bg-paper-2 hover:!text-ink hover:!shadow-[inset_0_0_0_1px_theme(colors.ink)] disabled:cursor-not-allowed disabled:!bg-disabled disabled:!text-muted md:h-14 md:text-[13px] md:tracking-[0.1em]"
              >
                {product.isSoldOut ? "SOLD OUT" : "ADD TO CART"}
              </button>

              <ProductAccordions description={product.description} />
            </div>
        </div>

        <RelatedProducts products={related} />
       </section> 
    )
}