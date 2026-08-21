// apps/storefront/src/lib/cart.ts
//
// Cart session persistence + reconciliation vocabulary.
//
// The backend owns the cart; the storefront only persists the cart session id
// (a single opaque uuid) so the authoritative projection can be re-fetched
// across page loads. Local storage NEVER holds prices, totals, quantities, or
// line data — only the session id. Server money (cartTotalMinor,
// taxAmountMinor, line unitPriceMinor/lineTotalMinor, shipping amountMinor) is
// the only money the UI ever renders.

const CART_ID_KEY = "QUHA-cart-id";

/**
 * F7 / G032 — the cart DISPLAY currency is the authoritative `currency` code
 * on the server's Cart projection. No conversion is ever performed and no
 * client-side currency choice exists; the fallback (the storefront region's
 * default) applies only while no cart projection is available yet.
 */
export function displayCurrencyOf(
  cart: { currency?: string | null } | null | undefined,
  fallback: string,
): string {
  const code = cart?.currency;
  return typeof code === "string" && code.trim() !== "" ? code : fallback;
}

export function readCartId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(CART_ID_KEY);
  } catch {
    return null;
  }
}

export function persistCartId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CART_ID_KEY, id);
  } catch {
    // Storage disabled/full — the cart still works for this session.
  }
}

export function clearCartId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CART_ID_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * A cart projection is reusable for the current session when it is not
 * terminal: a `converted` cart has been turned into an order and a `frozen`
 * cart is locked — both must be replaced with a fresh session rather than
 * mutated further.
 */
export function isCartActionable(cart: {
  status: "active" | "converted";
  frozen?: boolean;
}): boolean {
  return cart.status === "active" && !cart.frozen;
}