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

interface WishlistContextValue{
    items: string[],
    toggle: (productId: string) => void,
    isSaved: (productId: string) => boolean,
}

const WishlistContext = createContext<WishlistContextValue | undefined>(undefined);

// The key used in localStorage to persist the wishlist across page reloads.
const STORAGE_KEY = "QUHA-wishlist";

export function WishlistProvider({ children }: { children: ReactNode }){
  const [items, setItems] = useState<string[]>([])
  useEffect(() => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setItems(JSON.parse(saved));
    } catch {
        // ignore
    }
  }, []);

  useEffect(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
      } catch {
        // 
      }
  }, [items]);

  const toggle = useCallback((productId: string) => {
    setItems((prev) => 
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    )
  }, [])

  const isSaved = useCallback((productId: string) => {
    return items.includes(productId)
  }, [items])

  const value = useMemo(() => ({ items, toggle, isSaved }), [items, toggle, isSaved]);

  return (
    <WishlistContext.Provider value={value}>
        {children}
    </WishlistContext.Provider>
);
}

export function useWishlist(): WishlistContextValue {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error("useWishlist must be used inside <WishlistProvider>");
  return ctx;
}