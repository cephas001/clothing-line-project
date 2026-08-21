// apps/storefront/src/lib/authGates.ts
//
// F8 Part 3 — identity-gating rules (pure, no React, no HTTP).
//
// Two decisions must NEVER be made against an unresolved identity:
//
//   1. ACCOUNT DATA — the account view fires bearer-protected requests
//      (/me/addresses, /me/orders). A known guest must never trigger them,
//      and while identity resolution is in flight nothing may fire either.
//      The view renders through this gate; the data sections only MOUNT on
//      "ready", so their fetch effects cannot even exist before then.
//
//   2. THE HEADER ACCOUNT BUTTON — clicking it while identity is unresolved
//      must neither navigate nor open the sign-in drawer (both would present
//      a stale/wrong state the moment resolution lands). The click waits.

export type AuthStatus =
  | "loading"
  | "authenticated"
  | "guest"
  | "error";

export type AccountDataGate = "wait" | "signin" | "ready" | "identity-error";

export type AccountClickAction = "navigate" | "open-auth" | "wait";

/**
 * Whether the account view may render its data sections (and thus fire its
 * protected requests). Mirrors the G009 order-detail vocabulary:
 *
 *   loading          -> "wait"            (identity unresolved; no request)
 *   guest            -> "signin"          (known guest; protected data never fetched)
 *   authenticated    -> "ready"           (bearer available; safe to request)
 *   error            -> "identity-error"  (resolution failed transiently;
 *                                          retry IDENTITY first — the account
 *                                          request would just 401 on a stale
 *                                          token or duplicate the failure)
 */
export function resolveAccountDataGate(
  authStatus: AuthStatus,
): AccountDataGate {
  if (authStatus === "loading") return "wait";
  if (authStatus === "guest") return "signin";
  if (authStatus === "authenticated") return "ready";
  return "identity-error";
}

/** What the header account button does for the current identity state. */
export function resolveAccountClick(
  authStatus: AuthStatus,
): AccountClickAction {
  if (authStatus === "authenticated") return "navigate";
  if (authStatus === "loading") return "wait";
  // Guests AND transient identity errors open the drawer: signing in
  // re-resolves the identity, and no protected request is involved.
  return "open-auth";
}
