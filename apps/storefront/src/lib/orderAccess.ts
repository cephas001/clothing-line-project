// apps/storefront/src/lib/orderAccess.ts
//
// G009 — order-detail authentication gate (pure rule, no React, no HTTP).
//
// The identity is resolved BEFORE any bearer-protected order request is made:
// the fetch must not fire while the identity is still loading (the bearer may
// be absent or about to be revoked) and must NEVER fire for a known guest —
// guests get the sign-in state instead of a guaranteed-401 round trip.
//
//   loading       -> "wait"    (identity unresolved; no request yet)
//   guest         -> "signin"  (known guest; protected order never fetched)
//   authenticated -> "fetch"   (bearer available; safe to request)
//   error         -> "fetch"   (identity resolution failed transiently; the
//                               order request itself surfaces the authoritative
//                               outcome — a stale token gets a real 401 and a
//                               retry stays possible without a sign-in wall)

export type OrderFetchGate = "wait" | "signin" | "fetch";

export function resolveOrderFetchGate(
  authStatus: "loading" | "authenticated" | "guest" | "error",
): OrderFetchGate {
  if (authStatus === "loading") return "wait";
  if (authStatus === "guest") return "signin";
  return "fetch";
}
