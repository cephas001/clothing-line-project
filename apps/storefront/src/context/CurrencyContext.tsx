"use client"

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { formatPrice } from "@/lib/format";

// The storefront is region-scoped (NGN): there is no selectable currency. This
// context only exposes the shared display formatter so views never re-derive
// money formatting themselves. Currency is ALWAYS the code of the
// server-authoritative amount (order.currency / region currency) — never a
// client-side choice.
interface CurrencyContextValue {
    // format function
    format: (amount: number, currencyCode: string) => string;
}

// Context creation
const CurrencyContext = createContext<CurrencyContextValue | undefined>(undefined);

export function CurrencyProvider({ children }: { children: ReactNode }) {
    const value = useMemo<CurrencyContextValue>(
        () => ({
            format: (amount, currencyCode) => formatPrice(amount, currencyCode),
        }),
        []
    )
    return (
        <CurrencyContext.Provider value={value}>
            {children}
        </CurrencyContext.Provider>
    )
}


// Custom hook
export function useCurrency(): CurrencyContextValue {
    const ctx = useContext(CurrencyContext);
    if(!ctx) throw new Error("useCurrency must be used inside <CurrencyProvider>");
    return ctx;
}