// apps/storefront/src/lib/orderReceipt.ts
//
// Post-purchase persistence (F6 Slice 2A — G004 + G003 verification support).
//
// Two small localStorage records, both SSR-guarded, holding NO money values:
//
//   1. Order receipt — written ONLY when a server projection has confirmed
//      payment (paid / converted / orderId present). It gives a successful
//      purchase a PERSISTENT path to `/account/orders/{id}`: after conversion
//      the cart session is terminal and cart-session recovery (Slice 1)
//      replaces it with a fresh one on the next boot, so the live cart can no
//      longer vouch for the order — the receipt can.
//
//   2. Pending payment — written BEFORE the browser is handed to the hosted
//      gateway. It records WHICH cart session the attempt belongs to, so the
//      return leg verifies the authoritative projection of THAT exact cart
//      even if session recovery swapped it while the customer was away.

export interface OrderReceipt {
  /** Server-issued order id (uuid) from a confirmed cart projection. */
  orderId: string;
  /** Gateway reference returned to `returnUrl` (best-effort context). */
  reference: string | null;
  /** When the server confirmation was observed (ISO-8601). */
  confirmedAt: string;
}

export interface PendingPaymentRecord {
  /** The cart session the payment attempt was initialized against. */
  cartId: string;
  /** The gateway reference for THIS attempt (from PaymentSessionResponse). */
  reference: string;
  /** When the attempt started (ISO-8601). */
  startedAt: string;
}

const RECEIPT_KEY = "QUHA-order-receipt";
const PENDING_KEY = "QUHA-pending-payment";

function readJson<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage disabled/full — confirmation still renders for this session.
  }
}

function removeKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOrderReceipt(value: unknown): value is OrderReceipt {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.orderId) &&
    (typeof record.reference === "string" || record.reference === null) &&
    isNonEmptyString(record.confirmedAt)
  );
}

function isPendingPayment(value: unknown): value is PendingPaymentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.cartId) &&
    isNonEmptyString(record.reference) &&
    isNonEmptyString(record.startedAt)
  );
}

/** Persist the confirmed-order receipt (called ONLY on server confirmation). */
export function persistOrderReceipt(receipt: OrderReceipt): void {
  writeJson(RECEIPT_KEY, receipt);
}

/** The last server-confirmed order, or null. */
export function readLastOrderReceipt(): OrderReceipt | null {
  return readJson<OrderReceipt>(RECEIPT_KEY, isOrderReceipt);
}

export function clearOrderReceipt(): void {
  removeKey(RECEIPT_KEY);
}

/**
 * Record the in-flight payment attempt BEFORE redirecting to the gateway so
 * the return leg knows which cart session to verify.
 */
export function persistPendingPayment(record: PendingPaymentRecord): void {
  writeJson(PENDING_KEY, record);
}

export function readPendingPayment(): PendingPaymentRecord | null {
  return readJson<PendingPaymentRecord>(PENDING_KEY, isPendingPayment);
}

export function clearPendingPayment(): void {
  removeKey(PENDING_KEY);
}
