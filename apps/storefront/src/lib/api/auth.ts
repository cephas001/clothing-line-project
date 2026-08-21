// apps/storefront/src/lib/api/auth.ts
//
// Bearer-token store for the storefront.
//
// The API issues a single signed JWT (`POST /store/auth` -> `{ accessToken }`)
// with NO refresh token, so the storefront persists the token in localStorage
// and re-attaches it as `Authorization: Bearer <token>` on authenticated
// requests. On a 401 the AuthContext clears it and falls back to guest.
//
// SSR-safe: localStorage does not exist server-side, so every accessor guards
// on `typeof window` and returns null/undefined rather than throwing.

const TOKEN_KEY = "QUHA-access-token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage disabled/full — auth still works for the current session.
  }
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function hasToken(): boolean {
  return getToken() !== null;
}