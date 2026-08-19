// apps/api/src/domain/shared/inventoryReservationKey.ts
//
// L9 — DETERMINISTIC RESERVATION IDEMPOTENCY KEY (INV-I3 / INV-I4).
//
// The reservation ledger's UNIQUE `reservation_key` is derived ONLY from
// business inputs (order + variant + location) — never a random nonce — so a
// retried or concurrent duplicate reservation request produces the SAME key,
// collides at the database, and rolls back instead of double-reserving. This
// is what makes at-least-once delivery safe: a committed reservation replays
// to the same row; a release/confirm replays to a terminal status.

export type ReservationScope = "order" | "swap";

export function buildReservationKey(
  orderId: string,
  variantId: string,
  locationId: string,
): string {
  return `reserve:${orderId}:${variantId}:${locationId}`;
}

/**
 * Deterministic key for a reservation anchored on a SWAP (the replacement
 * variant held when an order swap is created). The `swap:` scope prefix keeps
 * swap-anchored keys structurally distinct from order-anchored keys even if the
 * two id namespaces ever overlap — a collision is impossible by construction,
 * so a retried/concurrent duplicate swap reservation collides at the SAME key
 * (INV-I3 / INV-I4) instead of double-reserving.
 */
export function buildSwapReservationKey(
  swapId: string,
  variantId: string,
  locationId: string,
): string {
  return `reserve:swap:${swapId}:${variantId}:${locationId}`;
}