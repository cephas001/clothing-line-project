"use client"
import {
  createContext,
  useContext,
  useState,
  useMemo,
  type ReactNode,
} from "react";
import { formatPrice } from "@/lib/format";
// Creating the currency object
interface CurrencyContextValue {
    currency: string;
    setCurrency: (c: string) => void;
    // format function
    format: (amount: number, currencyCode: string) => string;
}

// Context creation
const CurrencyContext = createContext<CurrencyContextValue | undefined>(undefined);

export function CurrencyProvider({ children }: { children: ReactNode }) {
    const [currency, setCurrency] = useState<string>("ngn");
    
    const value = useMemo<CurrencyContextValue>(
        () => ({
            currency,
            setCurrency,
            format: (amount, currencyCode) => formatPrice(amount, currencyCode),
        }),
        [currency]
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