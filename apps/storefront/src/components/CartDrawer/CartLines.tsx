"use client";

// apps/storefront/src/components/CartDrawer/CartLines.tsx
//
// Drawer line list. Lines are the server Cart projection resolved to UI views
// (see CartContext). Every amount rendered is server-sourced (unitPriceMinor /
// lineTotalMinor); optimistic changes show a syncing marker and resolve the
// moment the backend projection is reconciled.

import { Minus, Plus } from "lucide-react";
import { useCart } from "@/context/CartContext";
import { useCurrency } from "@/context/CurrencyContext";
import ProductImage from "../ProductImage/ProductImage";

export default function CartLines() {
    const { lines, changeQty, removeLine, syncing } = useCart();
    const { format } = useCurrency();

    if(lines.length === 0) {
        return (
          <div className="py-10 text-center font-mono text-[11px] uppercase tracking-[0.05em] text-muted md:text-[12px]">
            YOUR CART IS EMPTY
          </div>
        );
    }

    return (
        <>
          {lines.map((line) => (
            <div
                key={line.key}
                className="flex gap-3 border-b border-[#e5e3df] py-3.5 md:gap-3.5 md:py-4"
            >
             {/*  Thumbnail, positioned so ProductImage can fill it. */}
              <div className="relative h-[70px] w-14 flex-shrink-0 bg-placeholder md:h-[88px] md:w-[72px]">
                <ProductImage
                src={line.product?.media[0]?.url ?? ""}
                alt={line.product?.media[0]?.alt || line.product?.name || "Item"}
                label={(line.product?.name ?? "ITEM").split(" ")[0].toUpperCase()}
                sizes="72px"
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 truncate font-display text-[11px] font-semibold uppercase md:text-[12px]">
                    {line.product?.name ?? "Item"}
                    {line.pending && (
                      <span className="ml-2 font-mono text-[9px] tracking-[0.08em] text-muted">
                        SYNCING
                      </span>
                    )}
                </div>
                {line.variant && line.variant.label !== "OS" && (
                  <div className="mb-1.5 font-mono text-[10px] text-muted md:text-[11px]">
                    SIZE {line.variant.label}
                  </div>
                )}

            {/* Qty stepper */}
            <div className="flex items-center gap-2 md:gap-2.5">
               <button
                    type="button"
                    onClick={() => changeQty(line.key, -1)}
                    aria-label="Decrease quantity"
                    className="flex h-[18px] w-[18px] cursor-pointer items-center justify-center border border-ink bg-transparent p-0 text-ink md:h-5 md:w-5"
                >
                   <Minus size={12} strokeWidth={1.75} />
                </button>
                <span className="font-mono text-[11px] md:text-[12px]">
                   {line.qty}
                </span>
                <button
                    type="button"
                    onClick={() => changeQty(line.key, 1)}
                    aria-label="Increase quantity"
                    className="flex h-[18px] w-[18px] cursor-pointer items-center justify-center border border-ink bg-transparent p-0 text-ink md:h-5 md:w-5"
                >
                   <Plus size={12} strokeWidth={1.75} />
                </button>
                {line.syncing && !line.pending && (
                  <span className="font-mono text-[9px] tracking-[0.08em] text-muted">
                    {syncing ? "…" : ""}
                  </span>
                )}
            </div>
              </div>
            {/* Line total + remove button  */}
             <div className="flex-shrink-0 text-right">
               <div className="mb-1.5 font-mono text-[11px] md:mb-2 md:text-[12px]">
                {!line.pending && line.lineTotalMinor != null
                    ? format(line.lineTotalMinor, line.product?.currencyCode ?? "NGN")
                    : line.unitPriceMinor > 0
                      ? format(line.unitPriceMinor, line.product?.currencyCode ?? "NGN")
                      : "-"}
               </div>
               <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    className="cursor-pointer border-none bg-transparent p-0 font-mono"
                >
                    REMOVE
               </button>
             </div>
            </div>
          ))}
        </>
    )
}