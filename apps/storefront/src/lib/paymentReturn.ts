// apps/storefront/src/lib/paymentReturn.ts
//
// Gateway-return classification (F6 Slice 2A — G003).
//
// The hosted gateway redirects back to /checkout?reference=... on ANY ending
// of the attempt — the URL alone NEVER tells the storefront what happened.
// This module classifies the return into honest, mutually distinct states
// using ONLY server-authoritative signals (the Cart projection's
// paymentStatus: "pending" | "initialized" | "paid") plus observable facts:
//
//   confirmed      the server projection says paid / converted / has orderId —
//                  OR a persisted order receipt whose reference EXACTLY matches
//                  this return proves a prior server confirmation
//                  (F6.6-G001: revisiting ?reference=X after the cart converted
//                  and session recovery swapped in a fresh cart).
//   verifying      a reference is present and the verification window is still
//                  open — payment is pending/processing; nothing is claimed.
//   not_confirmed  the authoritative projection reports NO live charge
//                  (paymentStatus "pending") AND no matching receipt exists:
//                  initialization never completed or the obligation was reset.
//                  Waiting cannot change this — it is the cancelled/
//                  not-confirmed case. It must NEVER be presented as "still
//                  confirming".
//   timeout        the window closed while the server still reports a LIVE
//                  obligation ("initialized"): confirmation has genuinely timed
//                  out. Presented as neither success nor definitive failure;
//                  recovery is [Check again].
//
// The frontend never fabricates an order id, never marks a payment paid, and
// never derives money from these states.

/** How long the storefront polls the authoritative projection before the
 * verification window closes (~20 × 2.5s ≈ 50s). */
export const MAX_PAYMENT_VERIFY_ATTEMPTS = 20;

export type GatewayReturnState =
  | "idle"
  | "verifying"
  | "confirmed"
  | "timeout"
  | "not_confirmed";

export interface GatewayReturnInput {
  /** A `?reference=` is present in the URL (the gateway sent us back). */
  hasReference: boolean;
  /**
   * F6.6-G001: the `?reference=` VALUE from the URL. Required only for the
   * persisted-receipt precedence below; omit it (or pass null) to skip that
   * path entirely.
   */
  reference?: string | null;
  /**
   * F6.6-G001: the reference recorded on the PERSISTED, SHAPE-VALIDATED order
   * receipt — i.e. the value comes from `readLastOrderReceipt()` in
   * `orderReceipt.ts`, which applies the strict record validator (malformed or
   * wrong-shaped storage yields null). This classifier deliberately accepts
   * ONLY the already-validated reference so "a receipt exists" can never be
   * conflated with "THIS reference was confirmed".
   */
  receiptReference?: string | null;
  /** The authoritative projection says paid / converted / carries an orderId. */
  serverConfirmed: boolean;
  /**
   * The cart projection's paymentStatus — null/undefined while no projection
   * has loaded yet. Values mirror the OpenAPI Cart schema exactly.
   */
  paymentStatus: "pending" | "initialized" | "paid" | null | undefined;
  /** Verification reads performed so far. */
  attempts: number;
  /** Window size (MAX_PAYMENT_VERIFY_ATTEMPTS). */
  maxAttempts: number;
}

/**
 * G003: classify a gateway return. Pure — every input is either a URL fact or
 * a field of a server-fetched projection / validated persisted record.
 *
 * Precedence (F6.6-G001):
 *   1. server projection proves confirmation            → confirmed
 *   2. persisted receipt reference === URL reference    → confirmed
 *      (exact string match on the VALIDATED receipt; a receipt for any other
 *      reference, or an unreadable/malformed one, never confirms)
 *   3. no live charge ("pending") and no matching receipt → not_confirmed
 *   4. window still open                                 → verifying
 *   5. live obligation past the window                   → timeout
 */
export function classifyGatewayReturn(input: GatewayReturnInput): GatewayReturnState {
  if (!input.hasReference) return "idle";
  if (input.serverConfirmed) return "confirmed";
  // A prior server confirmation is proven when the VALIDATED persisted
  // receipt's reference exactly equals THIS return's reference. Both values
  // must be non-empty strings — "receipt exists" alone is never proof.
  if (isNonEmptyString(input.reference) && isNonEmptyString(input.receiptReference)) {
    if (input.receiptReference === input.reference) return "confirmed";
  }
  // No live charge exists for this checkout (initialization never completed,
  // or the obligation was reset): polling cannot change the outcome. This is
  // the cancelled / not-confirmed case — never rendered as "still confirming".
  if (input.paymentStatus === "pending") return "not_confirmed";
  if (input.attempts < input.maxAttempts) return "verifying";
  // A live obligation that never confirmed within the window: genuine timeout.
  return "timeout";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * G004: the contract allows linking the resulting order only when the viewer
 * is authenticated AND the server projection carried the order id. Guests get
 * reference/email confirmation instead — never a faked account path.
 */
export function canLinkOrderToAccount(
  isAuthenticated: boolean,
  orderId: string | null | undefined,
): boolean {
  return isAuthenticated && typeof orderId === "string" && orderId.length > 0;
}

/** Auth statuses mirrored structurally from AuthContext (keeps this module pure). */
export type CheckoutAuthStatus = "loading" | "authenticated" | "guest" | "error";

/**
 * G005: the sign-in affordance shows ONLY for guests — authenticated shoppers
 * are never nagged, and guest checkout is never blocked.
 */
export function showGuestSignInAffordance(status: CheckoutAuthStatus): boolean {
  return status === "guest";
}
