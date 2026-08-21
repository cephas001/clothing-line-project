// apps/storefront/src/lib/wishlistStorage.ts
//
// F6.6-G004 — wishlist persistence rules (pure logic, no React).
//
// The wishlist is a LOCAL convenience list of product ids; it is never
// backend-backed and never holds money, identity, or session data. Storage is
// treated as UNTRUSTED input: only an array of strings is accepted, and any
// malformed or wrong-shaped value (unparseable JSON, objects, numbers, arrays
// containing non-strings) is discarded for an empty list — never thrown, so
// nothing can crash during render. Every accessor is SSR-guarded and
// try/catch-wrapped (storage may also be disabled/full).

export const WISHLIST_STORAGE_KEY = "QUHA-wishlist";

/**
 * Tiny structural validator: ONLY an array of strings passes. Anything else —
 * `{"unexpected":"object"}`, `5`, `"saved"`, `[1, null]` — is rejected.
 */
export function isStringIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

/** The persisted wishlist, or [] when absent/invalid. Never throws. */
export function readWishlist(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WISHLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return isStringIdList(parsed) ? parsed : [];
  } catch {
    // Malformed JSON or a failing storage read — fail safe to empty.
    return [];
  }
}

/** Persist the wishlist; storage failures never break the session. */
export function writeWishlist(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage disabled/full — the wishlist still works for this session.
  }
}
