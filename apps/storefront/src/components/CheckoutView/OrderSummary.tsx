"use client";

// apps/storefront/src/components/CheckoutView/OrderSummary.tsx
//
// Order summary. Every figure is a SERVER value from the Cart projection:
//   SUBTOTAL  = cart.cartTotalMinor      (server-computed Σ unitPriceMinor × qty)
//   DISCOUNT  = applied promotion code  (server applies/validates; the server
//                                        does not expose a discount amount on
//                                        the cart DTO, so none is shown here)
//   TAX       = cart.taxAmountMinor      (server recomputed on address set)
//   SHIPPING  = selected option amountMinor (server-frozen on selection)
//   TOTAL     = display-only aggregation of the above server components; it is
//               never sent to the API (payment amounts are computed server-side
//               and persisted as the payment obligation).
// The client-side VALID_CODES mock and discount math are REMOVED — the frontend
// never acts as a pricing engine.

import { useState } from "react";
import type { CartLine } from "@/lib/types";
import { useCurrency } from "@/context/CurrencyContext";
import ProductImage from "@/components/ProductImage/ProductImage";

interface OrderSummaryProps {
  lines: CartLine[];
  subtotalAmount: number;
  taxAmountMinor: number | null;
  shippingAmountMinor: number | null;
  totalAmountMinor: number;
  currency: string;
  appliedPromotion: { id: string; code: string } | null;
  onApplyDiscount: (code: string) => Promise<void>;
  discountError: string | null;
  shippingLabel: string | null;
}

export default function OrderSummary({
  lines,
  subtotalAmount,
  taxAmountMinor,
  shippingAmountMinor,
  totalAmountMinor,
  currency,
  appliedPromotion,
  onApplyDiscount,
  discountError,
  shippingLabel,
}: OrderSummaryProps) {
  const { format } = useCurrency();
  const [code, setCode] = useState<string>("");
  const [applying, setApplying] = useState(false);

  const handleApply = async () => {
    if (!code.trim() || applying) return;
    setApplying(true);
    try {
      await onApplyDiscount(code.trim());
      setCode("");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div>
      {/* Line items */}
      {lines.map((line) => (
        <div key={line.key} className="mb-3 flex gap-3 border-b border-[#e5e3df] pb-3">
          <div className="relative h-16 w-14 flex-shrink-0 bg-placeholder">
            <ProductImage
              src={line.product?.media[0]?.url ?? ""}
              alt={line.product?.media[0]?.alt || line.product?.name || "Item"}
              label={(line.product?.name ?? "ITEM").split(" ")[0].toUpperCase()}
              sizes="56px"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-[12px] font-semibold uppercase">
              {line.product?.name ?? "Item"}
            </div>
            {line.variant && line.variant.label !== "OS" && (
              <div className="font-mono text-[10px] text-muted">SIZE {line.variant.label}</div>
            )}
            <div className="font-mono text-[10px] text-muted">QTY {line.qty}</div>
          </div>
          <div className="flex-shrink-0 font-mono text-[11px]">
            {line.lineTotalMinor != null
              ? format(line.lineTotalMinor, currency)
              : "—"}
          </div>
        </div>
      ))}

      {/* Discount code — applied by the server; no amount is computed here. */}
      {appliedPromotion ? (
        <div className="mt-4 flex items-center justify-between border border-ink px-3 py-2">
          <span className="font-mono text-[11px]">CODE: {appliedPromotion.code}</span>
          <span className="font-mono text-[10px] text-muted">APPLIED BY STORE</span>
        </div>
      ) : (
        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleApply();
              }
            }}
            aria-label="Discount code"
            placeholder="DISCOUNT CODE"
            className="flex-1 border border-ink bg-transparent px-3 py-2 font-mono text-[11px] uppercase outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={applying || !code.trim()}
            className="cursor-pointer border border-ink bg-ink px-4 font-mono text-[11px] tracking-[0.06em] text-paper-2 hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:!bg-disabled disabled:!text-muted"
          >
            {applying ? "APPLYING…" : "APPLY"}
          </button>
        </div>
      )}
      {discountError && (
        <div className="mt-2 font-mono text-[10px] text-muted">{discountError}</div>
      )}

      {/* Totals — every figure is server-sourced. */}
      <div className="mt-4 flex flex-col gap-2 font-mono text-[12px]">
        <div className="flex justify-between">
          <span>SUBTOTAL</span>
          <span>{format(subtotalAmount, currency)}</span>
        </div>

        <div className="flex justify-between">
          <span>TAX</span>
          <span>{taxAmountMinor != null ? format(taxAmountMinor, currency) : "—"}</span>
        </div>

        <div className="flex justify-between">
          <span>SHIPPING</span>
          <span>
            {shippingAmountMinor != null
              ? format(shippingAmountMinor, currency)
              : shippingLabel ?? "—"}
          </span>
        </div>

        <div className="mt-2 flex justify-between border-t border-ink pt-3 text-[14px] font-semibold">
          <span>TOTAL</span>
          <span>{format(totalAmountMinor, currency)}</span>
        </div>
      </div>
    </div>
  );
}