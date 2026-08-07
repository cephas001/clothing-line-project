"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import type { ProductView, CartItem, CartLine } from "@/lib/types";
import { getAllProducts } from "@/lib/product";

// Everything the cart exposes.

interface CartContextValue {
    lines: CartLine[];
    count: number; 
    subtotalAmount: number;
    subtotalCurrency: string;
    isOpen: boolean;
    openCart: () => void; 
    closeCart: () => void; 
    toggleCart: () => void;
    addToCart: (product: ProductView, variantId: string) => void;
    changeQty: (key: string, delta: number) => void;
    removeLine: (key: string) => void;
}

// Creates the actual React Context. It starts as undefined
const CartContext = createContext<CartContextValue | undefined>(undefined);

// Creates a unique string key for each product + variant combination.
const makeKey = (productId: string, variantId: string) => 
    `${productId}__${variantId}`

// The key used in localStorage to persist the cart across page reloads.
const STORAGE_KEY = "grey-wears-cart";

export function CartProvider({ children }: { children: ReactNode }) {
    // Raw cart stored as an object
    // Whether cart drawer is open
    const [items, setItems] = useState<Record<string, CartItem>>({});
    const [isOpen, setIsOpen] = useState(false);
    
    // Runs once when the component mounts.
    // It tries to restore the cart from localStorage. If the data is corrupted, it silently ignores it.
    useEffect(() => {
        try {
          const saved = localStorage.getItem(STORAGE_KEY);
          if (saved) setItems(JSON.parse(saved));
        } catch {
            // Malformed storage
        }
    })
    // Whenever items changes, this effect writes the new cart back to localStorage.
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        } catch {
            // Storage disabled / full
        }
    }, [items]), 
}