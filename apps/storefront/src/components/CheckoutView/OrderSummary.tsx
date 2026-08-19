"use client";

import { useState } from "react";
import type { CartLine } from "@/lib/types";
import { useCurrency } from "@/context/CurrencyContext";
import ProductImage from "@/components/ProductImage/ProductImage";


// Hardcoded, to be removed later on. 
const VALID_CODES: Record<string, { type: "percent" | "fixed"; value: number}> ={
  WELCOME10: { type: "percent", value: 10 },
  QUHA20:    { type: "percent", value: 20 },
  BLK5000:   { type: "fixed",   value: 5000 },  
}
interface OrderSummaryProps {
  lines: CartLine[];
  total: number;
  currency: string;
}

export default function OrderSummary({ lines, total, currency }: OrderSummaryProps) {
  const { format } = useCurrency();

  const[code, setCode] = useState<string>("");
  const[applied, setApplied] = useState<{ code: string; amount: number} | null>(null);
  
  // Calculate subtotal from lines
  const subtotal = lines.reduce(
    (sum, l) => sum + l.product.priceAmount * l.qty,
    0
  );
  const shipping = total - subtotal;

  const discountAmount = applied ? applied.amount : 0;
  // Ensures the total is never a negative amount
  const finalTotal = Math.max(0, total - discountAmount);

  // Function to run when the user tries to apply a discount code.
  const applyCode = () => {
    // Removes whitespaces and converts to uppercase
    const cleaned = code.trim().toUpperCase();
    // Checks if that cleaned code exists in VALID_CODES object.
    const match = VALID_CODES[cleaned]

    if(!match) {
      setCode("");
      return;
    }
    const amount = 
        match.type === "percent"
          ? Math.round((subtotal * match.value) / 100)
          : match.value;

          // Stores which code was used 
          // And how much discount it gives
      setApplied({ code: cleaned, amount })
      setCode("");

    };

    const removeDiscount = () => {
      setApplied(null);
    }

  return (
    <div>
      {/* Line items */}
      {lines.map((line) => (
        <div key={line.key} className="mb-3 flex gap-3 border-b border-[#e5e3df] pb-3">
          <div className="relative h-16 w-14 flex-shrink-0 bg-placeholder">
            <ProductImage
              src={line.product.images.studio}
              alt={line.product.name}
              label={line.product.name.split(" ")[0].toUpperCase()}
              sizes="56px"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-[12px] font-semibold uppercase">
              {line.product.name}
            </div>
            {line.variant && line.variant.label !== "OS" && (
              <div className="font-mono text-[10px] text-muted">SIZE {line.variant.label}</div>
            )}
            <div className="font-mono text-[10px] text-muted">QTY {line.qty}</div>
          </div>
          <div className="flex-shrink-0 font-mono text-[11px]">
            {line.product.priceAmount > 0
              ? format(line.product.priceAmount * line.qty, line.product.currencyCode)
              : "—"}
          </div>
        </div>
      ))}

      {/* Discount code */}
      {applied ? (
        <div className="mt-4 flex items-center justify-between border border-ink px-3 py-2">
          <span className="font-mono text-[11px]">CODE: {applied.code}</span>
          <button
            type="button"
            onClick={removeDiscount}
            className="cursor-pointer border-none bg-transparent p-0 font-mono text-[10px] text-muted underline"
          >
            REMOVE
          </button>
        </div>
      ) : (
        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="DISCOUNT CODE"
            className="flex-1 border border-ink bg-transparent px-3 py-2 font-mono text-[11px] uppercase outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={applyCode}
            className="cursor-pointer border border-ink bg-ink px-4 font-mono text-[11px] tracking-[0.06em] text-paper-2 hover:bg-paper-2 hover:text-ink"
            >
              APPLY
            </button>
        </div>
      )}

      {/* Totals */}
      <div className="mt-4 flex flex-col gap-2 font-mono text-[12px]">
        <div className="flex justify-between">
          <span>SUBTOTAL</span>
          <span>{format(subtotal, currency)}</span>
        </div>
        {applied && (
          <div className="flex justify-between">
            <span>DISCOUNT({applied.code})</span>
            <span>-{format(discountAmount, currency)}</span>
          </div>
        )}

        <div className="flex justify-between">
          <span>SHIPPING</span>
          <span>{shipping === 0 ? "FREE" : format(shipping, currency)}</span>
        </div>

        <div className="mt-2 flex justify-between border-t border-ink pt-3 text-[14px] font-semibold">
          <span>TOTAL</span>
          <span>{format(total, currency)}</span>
        </div>
      </div>
    </div>
  );
}