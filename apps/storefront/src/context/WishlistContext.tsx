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
import { readWishlist, writeWishlist } from "@/lib/wishlistStorage";

// F6.6-G004: persistence rules live in the pure lib module — storage is
// untrusted input, so only an array of strings is ever accepted and a
// malformed or wrong-shaped value fails safe to [] (never throws in render).

interface WishlistContextValue{
    items: string[],
    toggle: (productId: string) => void,
    isSaved: (productId: string) => boolean,
}

const WishlistContext = createContext<WishlistContextValue | undefined>(undefined);

export function WishlistProvider({ children }: { children: ReactNode }){
  // Read the persisted wishlist once, lazily, at first render. The reader is
  // SSR-guarded, so it never touches storage during server rendering.
  const [items, setItems] = useState<string[]>(readWishlist);

  useEffect(() => {
    writeWishlist(items);
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