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
import { useToast } from "./ToastContext";

// Everything the cart exposes.
// This is the contract that every consumer of the cart will see.
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
const STORAGE_KEY = "QUHA-cart";

export function CartProvider({ children }: { children: ReactNode }) {
    // Raw cart stored as an object
    // Whether cart drawer is open
    // Lazy initialization
    const [items, setItems] = useState<Record<string, CartItem>>(() => {
        if (typeof window === "undefined") return {};
        try {
             // Runs once when the component mounts.
    // It tries to restore the cart from localStorage. If the data is corrupted, it silently ignores it.
            const saved = localStorage.getItem(STORAGE_KEY);
            return saved ? JSON.parse(saved) : {}
        } catch {
            return {};
        }
    });
    const [isOpen, setIsOpen] = useState(false);
    const { showToast } = useToast();

    // Whenever items changes, this effect writes the new cart back to localStorage.
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        } catch {
            // Storage disabled / full
        }
    }, [items]);

    // Ignores sold-out products.
    // Uses the functional form of setItems so we always work with the latest state.
    // If the line already exists, increase qty.
    // If it’s new, create a new entry with qty: 1.
    // Automatically opens the cart drawer after adding.
    const addToCart = useCallback(
        (product: ProductView, variantId: string) => {
            if (product.isSoldOut) return;
            setItems((prev) => {
                const key = makeKey(product.id, variantId);
                const existing = prev[key];
                const nextItem: CartItem = existing
                    ? { ...existing, qty: existing.qty + 1 }
                    : { productId: product.id, variantId, qty: 1 }
                return {
                    ...prev,
                    [key]: nextItem
                }
            });
            setIsOpen(true);
            showToast("✅ Added to cart");
        },
        [showToast]
    );


    const changeQty = useCallback((key: string, delta: number) => {
        setItems((prev) => {
            const line = prev[key];
            if (!line) return prev;
            const qty = line.qty + delta;
            const next = { ...prev };
            if (qty <= 0) delete next[key];
            else next[key] = { ...line, qty };
            return next;
        });
    }, []);

    const removeLine = useCallback((key: string) => {
        setItems((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;  
        })
        showToast("✅ Removed from cart");
    }, [showToast]);


    // Hydration step
    // Takes the raw items (just IDs + quantities).
    // Looks up the full product and variant objects.
    // Builds a clean array of CartLine objects that the UI can render directly.
    // Calculates total item count and subtotal.
    // Picks a currency (falls back to "ngn").
    //useMemo ensures this only recalculates when items changes.
    
    const { lines, count, subtotalAmount, subtotalCurrency } = useMemo(() => {
        const all = getAllProducts();

        const built: CartLine[] = []
        for (const [key, item] of Object.entries(items)) {
           const product = all.find((p) => p.id === item.productId);
            if (!product) continue;
            const variant = product.variants.find((v) => v.id === item.variantId);
            built.push({
                key,
                productId: item.productId,
                variantId: item.variantId,
                qty: item.qty,
                product,
                variant, 
            }); 
        }

            return {
                lines: built,
                count: built.reduce((sum, l) => sum + l.qty, 0),
                subtotalAmount: built.reduce(
                    (sum, l) => sum + l.product.priceAmount * l.qty, 0
                ),
                // All lines share currency during mock dev; pick from the first line.
                subtotalCurrency: built[0]?.product.currencyCode ?? "ngn",
            };
    }, [items])

    // Creates a stable object that contains everything the cart exposes.
    // useMemo prevents the object from being recreated on every render
    const value = useMemo<CartContextValue>(
        () => ({
            lines,
            count,
            subtotalAmount,
            subtotalCurrency,
            isOpen,
            openCart: () => setIsOpen(true),     
            closeCart: () => setIsOpen(false),     
            toggleCart: () => setIsOpen((o) => !o),
            addToCart,
            changeQty,
            removeLine,     
        }),
        [lines, count, subtotalAmount, subtotalCurrency, isOpen, addToCart, changeQty, removeLine]
    )

    return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}


// Function hook for reminder in case
// someone forgets to wrap the app in <CartProvider>.
export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}