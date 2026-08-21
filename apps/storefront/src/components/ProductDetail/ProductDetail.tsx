"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ProductView } from "@/lib/types";
import { useCart } from "@/context/CartContext";
import { useCurrency } from "@/context/CurrencyContext";
import { availabilityOf, isSelectable, mergeAvailability } from "@/lib/availability";
import { useVariantAvailability } from "@/lib/catalog";
import ProductImage from "../ProductImage/ProductImage";
import ProductAccordions from "./ProductAccordions"
import RelatedProducts from "./RelatedProducts"


interface ProductDetailProps {
  product: ProductView;
  related: ProductView[];
  /** F8: the authoritative detail upgrade failed — data is real but from the browse snapshot. */
  detailUnavailable?: boolean;
}

export default function ProductDetail({ product, related, detailUnavailable = false }: ProductDetailProps) {
  const { addToCart, lines } = useCart();
  const { format } = useCurrency();

  // F7.1 / G017: live availability for the SELECTED variant. The hook guards
  // against stale responses (rapid size switches never apply out of order);
  // the fresh server answer is merged over the rendered view.
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    // Initially select the first ORDERABLE variant: in-stock preferred,
    // backorder allowed — never an out-of-stock one (G016).
    product.variants.find((v) => isSelectable(availabilityOf(v)))?.id ?? null
  );
  const liveAvailability = useVariantAvailability(selectedVariantId);
  const displayed = liveAvailability
    ? mergeAvailability(product, liveAvailability)
    : product;

  // From the ID stored in state, this finds the full variant object.
  const selectedVariant = displayed.variants.find((v) => v.id === selectedVariantId);
  const selectedState = selectedVariant
    ? availabilityOf(selectedVariant)
    : "out_of_stock";

  // Keeps track of which gallery image is currently showing (N-slot, G034).
  const [activeImg, setActiveImg] = useState(0);
  const media = displayed.media;
  const activeIndex = Math.min(activeImg, Math.max(0, media.length - 1));
  const activeMedia = media[activeIndex];

  const statusLabel = displayed.isSoldOut
        ? "SOLD OUT"
        : displayed.sellingFast
        ? "SELLING FAST"
        : null;

    // F7.1 / G015 — truthful add-to-cart busy state. The cart context tracks
    // every in-flight FIFO mutation: `pending` marks an optimistic add not yet
    // acknowledged by the server, `syncing` marks any line mutation in
    // flight. While either is true for THIS variant, duplicate submissions
    // are disabled; the flags clear on completion OR failure (server
    // reconcile), restoring the control. The FIFO queue itself is untouched.
  const variantInFlight = lines.some(
    (line) => line.variantId === selectedVariantId && (line.pending || line.syncing),
  );

    const handleAddToCart = () => {
        if (!isSelectable(selectedState) || !selectedVariantId || variantInFlight) return;
        addToCart(displayed, selectedVariantId)
    };

    const addToCartLabel = displayed.isSoldOut
      ? "SOLD OUT"
      : variantInFlight
      ? "ADDING…"
      : selectedState === "backorder"
      ? "ADD TO CART — BACKORDER"
      : "ADD TO CART";

    return (
       <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
        <div className="mb-6 break-words font-mono text-[10px] tracking-[0.06em] text-muted md:mb-8 md:text-[12px]">
            HOME / {displayed.category.toUpperCase()} / {displayed.name.toUpperCase()}
        </div>
        {/* F8 — honest degradation notice: the authoritative detail fetch
            failed, so this page shows the (real) catalogue snapshot. Never
            silent, never fabricated. */}
        {detailUnavailable && (
          <p className="mb-4 border border-[#e5e3df] bg-paper px-4 py-3 font-mono text-[10px] leading-relaxed tracking-[0.04em] text-muted md:text-[11px]">
            LIVE PRODUCT DETAILS ARE TEMPORARILY UNAVAILABLE — SHOWING CATALOGUE
            INFORMATION.
          </p>
        )}
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[1.1fr_1fr] md:gap-16">
          {/*  LEFT: image gallery (F7.1 / G034 — renders 0, 1 or N media items) */}
            <div>
               <div className="relative mb-3 aspect-[4/5] overflow-hidden bg-placeholder">
                  <AnimatePresence mode="wait">
                    <motion.div
                        key={activeIndex}
                        className="absolute inset-0"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                    >
                       <ProductImage
                          src={activeMedia?.url ?? ""}
                          alt={activeMedia?.alt ?? displayed.name}
                          label="IMAGE"
                          sizes="(max-width: 768px) 100vw, 55vw"
                          priority
                       />
                    </motion.div>
                  </AnimatePresence>
               </div>
                {/* Thumbnails — one per media item, wrapping for N items */}
               {media.length > 1 && (
                 <div className="flex flex-wrap gap-2">
                 {media.map((item, i) => (
                 <button
                   key={`${item.url}-${i}`}
                   type="button"
                   onClick={() => setActiveImg(i)}
                   aria-label={`View image ${i + 1} of ${media.length}`}
                   aria-current={activeIndex === i}
                   className={`relative h-[72px] w-[72px] cursor-pointer overflow-hidden border border-ink bg-placeholder p-0 ${
                     activeIndex === i ? "outline outline-2 outline-offset-2 outline-ink" : ""
                   }`}
                   >
                     <ProductImage src={item.url} alt={item.alt} label="IMAGE" sizes="72px" />
                   </button>
                 ))}
                 </div>
               )}
            </div>
            {/*  RIGHT: info + variants + add to cart  */}
            <div>
              <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.08em] text-muted md:text-[12px]">
                {displayed.category} / {selectedVariant?.sku ?? displayed.variants[0]?.sku ?? "-"}
              </div>

              <h1 className="mb-3 mt-0 font-display text-[22px] md:mb-4 md:text-[28px] md:leading-[1.15] font-bold uppercase eading-tight">
                {displayed.name}
              </h1>

              {/* Display-only price: the SELECTED variant's authoritative server
                  value (falls back to the product-level representative price). */}
              <div className="mb-4 font-mono text-[17px] md:mb-5 md:text-[20px]">
                {(selectedVariant?.priceMinor ?? displayed.priceMinor) != null
                  ? format(selectedVariant?.priceMinor ?? displayed.priceMinor ?? 0, displayed.currencyCode)
                  : "-"}
              </div>

              {/* Status Badge */}
              {statusLabel && (
                <div className="mb-4 inline-block bg-ink px-2.5 py-1.5 font-mono text-[10px] tracking-[0.05em] text-paper-2 md:mb-5 md:text-[11px] md:tracking-[0.06em]">
                  {statusLabel}
                </div>
              )}

             <div className="my-4 border-t border-line-soft md:my-6" />

              {displayed.variants.length > 1 && (
                <div className="mb-5 md:mb-7">
                  <div className="mb-2 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-2.5 md:text-[11px] md:tracking-[0.08em]">SIZE</div>
                  <div className="flex flex-wrap gap-1.5 md:gap-2">
                    {displayed.variants.map((v) => {
                      const isSelected = v.id === selectedVariantId;
                      const state = availabilityOf(v);
                      const selectable = isSelectable(state);
                      return(
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => selectable && setSelectedVariantId(v.id)}
                          disabled={!selectable}
                          aria-label={
                            state === "backorder"
                              ? `${v.label}, backorder`
                              : v.label
                          }
                          className={`min-w-[40px] cursor-pointer border border-ink px-3 py-2.5 font-mono text-[11px] md:min-w-[44px] md:px-3.5 md:py-2.5 md:text-[12px] ${
                            isSelected
                              ? "bg-ink text-paper-2"
                              : "bg-transparent text-ink"
                          } ${!selectable ? "cursor-not-allowed !text-muted line-through opacity-50" : ""}`}
                         >
                          {v.label}
                          {state === "backorder" && (
                            <span className="ml-1.5 align-middle font-mono text-[8px] uppercase tracking-[0.06em] opacity-80">
                              BACKORDER
                            </span>
                          )}
                         </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* F7.1 / G016 — truthful availability note for the selection.
                  Backorder means orderable-but-not-in-stock; no fulfillment
                  promises (ship windows / restock dates) are ever invented. */}
              {selectedState === "backorder" && (
                <p className="mb-4 mt-0 font-mono text-[11px] leading-relaxed text-muted">
                  Currently out of stock — available for backorder. You are ordering this size on demand; it is not physically in stock.
                </p>
              )}

              {/* Add to cart (F7.1 / G015 — disabled while this variant's
                  cart mutation is in flight; restored on completion/failure) */}
              <button
                type="button"
                onClick={handleAddToCart}
                disabled={displayed.isSoldOut || !selectedVariantId || variantInFlight}
                aria-live="polite"
                className="h-[50px] w-full cursor-pointer border-none bg-ink font-mono text-[12px] uppercase tracking-[0.08em] text-paper-2 hover:!bg-paper-2 hover:!text-ink hover:!shadow-[inset_0_0_0_1px_theme(colors.ink)] disabled:cursor-not-allowed disabled:!bg-disabled disabled:!text-muted md:h-14 md:text-[13px] md:tracking-[0.1em]"
              >
                {addToCartLabel}
              </button>

              <ProductAccordions description={displayed.description} />
            </div>
        </div>

        <RelatedProducts products={related} />
       </section>
    )
}
