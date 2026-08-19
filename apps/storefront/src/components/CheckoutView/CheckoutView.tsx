"use client";

import { useState } from "react";
import { useCart } from "@/context/CartContext";
import { useCurrency } from "@/context/CurrencyContext";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";
import OrderSummary from "./OrderSummary";
// import ProductImage from "../ProductImage/ProductImage";

export default function CheckoutView() {
    const { lines, count, subtotalAmount, subtotalCurrency } = useCart();
    const { format } = useCurrency();

    type CheckoutFormData = {
        email: string;
        firstName: string;
        lastName: string;
        address: string;
        city: string;
        state: string;
        postalCode: string;
        phone: string;
        shippingMethod: "standard" | "express";
        paymentMethod: "paystack" | "bank-transfer";
      }

      const [formData, setFormData] = useState<CheckoutFormData>({
        email: "",
        firstName: "",
        lastName: "",
        address: "",
        city: "",
        state: "",
        postalCode: "",
        phone: "",
        shippingMethod: "standard",
        paymentMethod: "paystack",
      })

      const [isMobileExpanded, setIsMobileExpanded] = useState<boolean>(false);

      const updateField = (field: keyof typeof formData, value: string) => {
        setFormData((prev) => ({
          ...prev, 
          [field]: value
        }))
      }

      const shippingCost = formData.shippingMethod === "express" ? 5000 : 0;
      const total = subtotalAmount + shippingCost;

      // To be changed to async whenever a real api is called
      const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        console.log("Checkout submitted:", { form: formData, lines, total });
      }

      if (lines.length === 0) {
        return (
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-4 text-center md:px-8">
          <h1 className="m-0 font-display text-[clamp(40px,9vw,96px)] font-black uppercase leading-[0.95]">
            LOST THE THREAD.
          </h1>
          <Link
            href="/shop"
            className="inline-block border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:!bg-ink hover:!text-paper-2 hover:!opacity-100 md:px-8 md:py-4 md:text-[12px]"
          >
            BACK TO HOME
          </Link>
        </div>
        )
      }

      return (
        <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
          {/* PAGE HEADING */}
          <div className="mb-2.5 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-3 md:text-[12px] md:tracking-[0.08em]">
            HOME / CHECKOUT
            </div>
          <h1 className="mb-4 mt-0 font-display text-[28px] font-bold uppercase md:mb-5 md:text-[44px]">
            CHECKOUT
          </h1>

          {/* MOBILE COLLAPSIBLE ORDER SUMMARY */}
          <div className="mb-6 md:hidden border border-ink">
            <button
              type="button"
              onClick={() => setIsMobileExpanded((o) => !o) }
              className="flex w-full items-center justify-between px-4 py-3.5 text-left"
              >
                <span className="font-mono text-[11px] uppercase tracking-[0.08em]">
                  ORDER SUMMARY ( {count} {count === 1 ? "item" : "items"} )
                </span>
                <span className="flex items-center gap-2 font-mono text-[12px]">
                  {format(total, subtotalCurrency)}
                  {isMobileExpanded ? (
                    <ChevronUp size={16} strokeWidth={1.75} />
                  ): (
                    <ChevronDown size={16} strokeWidth={1.75} />
                  )}
                </span>
              </button>

              <AnimatePresence initial={false}>
                {isMobileExpanded && (
                  <motion.div
                    key="mobile-summary"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden border-t border-ink"
                  >
                    <div className="p-4">
                      <OrderSummary
                        lines={lines}
                        total={total}
                        currency={subtotalCurrency}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
          </div>

           {/* MAIN LAYOUT */}
           <div className="grid grid-cols-1 gap-10 md:grid-cols-[1.5fr_1fr] md:gap-16">
            <form onSubmit={handleSubmit} className="flex flex-col gap-10">
            {/* CONTACT */}
              <div>
                <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">CONTACT</h2>
                <input
                  type="email"
                  placeholder="EMAIL"
                  required
                  onChange={(e) => updateField("email", e.target.value)}
                  value={formData.email}
                  className="w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink"
                  />
                </div>

                {/* SHIPPING ADDRESS */}
              <div>
                  <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">SHIPPING ADDRESS</h2>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
                    <input
                      type="text"
                      placeholder="FIRST NAME"
                      required
                      onChange={(e) => updateField("firstName", e.target.value)}
                      value={formData.firstName}
                      className="w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink"
                    />

                    <input
                      type="text"
                      placeholder="LAST NAME"
                      required
                      onChange={(e) => updateField("lastName", e.target.value)}
                      value={formData.lastName}
                      className="w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink"
                    />

                    <input
                      type="text"
                      placeholder="ADDRESS"
                      required
                      onChange={(e) => updateField("address", e.target.value)}
                      value={formData.address}
                      className="w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink md:col-span-2"
                    />

                    <input
                      type="text"
                      placeholder="CITY"
                      required
                      onChange={(e) => updateField("city", e.target.value)}
                      value={formData.city}
                      className="w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink"
                    />

                    <input
                      type="text"
                      placeholder="STATE"
                      required
                      value={formData.state}
                      onChange={(e) => updateField("state", e.target.value)}
                      className="w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink"
                    />

                    <input
                      type="text"
                      placeholder="POSTAL CODE"
                      required
                      value={formData.postalCode}
                      onChange={(e) => updateField("postalCode", e.target.value)}
                      className="w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink"
                    />

                    <input
                      type="tel"
                      placeholder="PHONE"
                      required
                      value={formData.phone}
                      onChange={(e) => updateField("phone", e.target.value)}
                      className="w-full border border-ink bg-transparent px-4 py-3 font-mono text-[13px] outline-none focus:border-ink"
                    />
                  </div>
                </div>

                {/* DELIVERY */}
                <div>
                  <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">DELIVERY</h2>
                  <div className="flex flex-col gap-2">
                    <label className={`flex cursor-pointer items-center justify-between border border-ink px-4 py-3
                        ${formData.shippingMethod === "standard"
                                  ? "bg-ink text-paper" : "bg-transparent"
                        }`}>
                      <input
                        type="radio"
                        name="shipping"
                        value="standard"
                        checked={formData.shippingMethod === "standard"}
                        onChange={(e) => updateField("shippingMethod", e.target.value)}
                        className="sr-only"
                        />
                        <div>
                          <div className="font-mono text-[12px] uppercase">STANDARD</div>
                          <div
                            className={`font-mono text-[10px] ${
                              formData.shippingMethod === "standard" ? "text-paper/70" : "text-muted"
                            }`}
                          >3-5 business days</div>
                        </div>
                        <div className="font-mono text-[12px]">FREE</div>
                    </label>

                    {/* EXPRESS */}
                  <label
                    className={`flex cursor-pointer items-center justify-between border border-ink px-4 py-3 ${
                      formData.shippingMethod === "express" ? "bg-ink text-paper" : "bg-transparent"
                    }`}
                  >
                    <input
                      type="radio"
                      name="shipping"
                      value="express"
                      checked={formData.shippingMethod === "express"}
                      onChange={() => updateField("shippingMethod", "express")}
                      className="sr-only"
                    />

                    <div>
                      <div className="font-mono text-[12px] uppercase">EXPRESS</div>
                      <div className="font-mono text-[10px] text-muted">1-2 business days</div>
                    </div>
                    <div className="font-mono text-[12px]">
                      {format(5000, subtotalCurrency)}
                    </div>
                    </label>
                 </div>
                </div>
                  {/* PAYMENT */}  
                  <div>
                      <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                      PAYMENT
                    </h2>
                    <div className="flex flex-col gap-2">
                      <label
                        className={`flex cursor-pointer items-center justify-between border border-ink px-4 py-3 ${
                          formData.paymentMethod === "paystack" ? "bg-ink text-paper" : "bg-transparent"
                        }`}
                      >
                        <input
                          type="radio"
                          name="payment"
                          value="paystack"
                          checked={formData.paymentMethod === "paystack"}
                          onChange={() => updateField("paymentMethod", "paystack")}
                          className="sr-only"
                        />

                        <div>
                          <div className="font-mono text-[12px] uppercase">PAYSTACK</div>
                          <div
                            className={`font-mono text-[10px] ${
                              formData.paymentMethod === "paystack" ? "text-paper/70" : "text-muted"
                            }`}
                          >
                            Pay with card, bank, USSD, or transfer
                          </div>
                        </div>
                      </label>

                      {/* BANK TRANSFER */}
                        <label
                          className={`flex cursor-pointer items-center justify-between border border-ink px-4 py-3 ${
                            formData.paymentMethod === "bank-transfer" ? "bg-ink text-paper" : "bg-transparent"
                          }`}
                        >
                          <input
                            type="radio"
                            name="payment"
                            value="bank-transfer"
                            checked={formData.paymentMethod === "bank-transfer"}
                            onChange={() => updateField("paymentMethod", "bank-transfer")}
                            className="sr-only"
                          />

                          <div>
                            <div className="font-mono text-[12px] uppercase">BANK TRANSFER</div>
                            <div
                              className={`font-mono text-[10px] ${
                                formData.paymentMethod === "bank-transfer" ? "text-paper/70" : "text-muted"
                              }`}
                            >
                              Manual transfer, we&apos;ll email details
                            </div>
                          </div>
                        </label>                        
                    </div>
                  </div>

             {/* SUBMIT BUTTON */}
              <button
                type="submit"
                className="h-14 w-full bg-ink font-mono text-[13px] uppercase tracking-[0.1em] text-paper-2 hover:!bg-paper-2 hover:!text-ink hover:!shadow-[inset_0_0_0_1px_theme(colors.ink)]"
              >
                {`PLACE ORDER - ${format(total, subtotalCurrency)}`}
                </button>     
            </form>

            {/* RIGHT: order summary — DESKTOP ONLY */}
            <aside className="hidden md:block">
              <div className="sticky top-24">
                <OrderSummary
                  lines={lines}
                  total={total}
                  currency={subtotalCurrency}
                />
              </div>
            </aside>                       
           </div>
        </section>
      )
}