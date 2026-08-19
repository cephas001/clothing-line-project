"use client";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useCart } from "@/context/CartContext";
import { useCurrency } from "@/context/CurrencyContext";
import { useEffect } from "react";
import CartLines from "./CartLines";
import { useRouter } from "next/navigation";

export default function CartDrawer() {
    const { isOpen, closeCart, count, subtotalAmount, subtotalCurrency, lines } = useCart();
    const { format } = useCurrency();
    const router = useRouter();
    // Page unable to scroll the drawer when it's open.
    useEffect(() => {
        document.body.style.overflow = isOpen ? "hidden" : "";
        return () => { document.body.style.overflow = ""; };
    }, [isOpen]);

    return (
       <AnimatePresence>
        {isOpen && (
            <>
            <motion.div
              key="cart-backdrop"
              onClick={closeCart}
              className="fixed inset-0 z-[150] bg-black/60"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            />
            
            {/* Panel */}
            <motion.aside
               key="cart-panel"
               role="dialog"
               aria-label="Shopping cart"
               className="fixed inset-y-0 right-0 z-[160] flex h-full w-[85%] flex-col border-l border-ink bg-paper md:w-[420px]"
               initial={{ x: "100%" }}
               animate={{ x: 0 }}
               exit={{ x: "100%" }}
               transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
            {/* Panel header */}
              <div className="flex flex-shrink-0 items-center justify-between border-b border-ink p-5 md:p-6">
                <div className="font-display text-[14px] font-bold uppercase tracking-[0.05em] md:text-[16px] md:tracking-[0.06em]">
                  CART ({count})
                </div>
                <button
                  type="button"
                  onClick={closeCart}
                  aria-label="Close cart"
                  className="cursor-pointer border-none bg-transparent p-1 text-ink"
                >
                   <X size={20} strokeWidth={1.5} /> 
              </button>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-1 md:px-6 md:py-2">
                <CartLines />
              </div>

              <div className="flex-shrink-0 border-t border-ink p-5 md:p-6">
                <div className="mb-3.5 flex justify-between font-mono text-[12px] md:mb-4 md:text-[13px]">
                   <span>SUBTOTAL</span> 
                   <span>{subtotalAmount > 0 
                     ? format(subtotalAmount, subtotalCurrency)
                     : "-"}
                    </span> 
                </div>
                <button
                  type="button"
                  disabled={lines.length === 0}
                  onClick={() => {
                    closeCart()
                    router.push("/checkout")
                  }} 
                  className="h-12 w-full cursor-pointer border-none bg-ink text-[12px] font-mono uppercase tracking-[0.08em] text-paper-2 hover:!bg-paper-2 hover:!text-ink hover:!shadow-[inset_0_0_0_1px_theme(colors.ink)] disabled:cursor-not-allowed disabled:!bg-disabled disabled:!text-muted md:h-[52px] md:text-[13px] md:tracking-[0.1em]"
                  >
                    CHECKOUT
                </button>
              </div>
          </motion.aside>
            </>
        )}
       </AnimatePresence> 
    )
}