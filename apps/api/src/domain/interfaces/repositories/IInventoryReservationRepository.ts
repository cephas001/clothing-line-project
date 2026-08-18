// apps/api/src/domain/interfaces/repositories/IInventoryReservationRepository.ts
//
// L9 — persistence contract for the durable reservation ledger
// (`inventory_reservation`).
//
// The `reservation_key` is UNIQUE and DETERMINISTIC
// (`reserve:${orderId}:${variantId}:${locationId}`), so a retried/concurrent
// duplicate reservation collides and the whole unit of work rolls back instead
// of double-reserving (INV-I3 / INV-I4). `save` is an upsert on the reservation
// `id`, so replaying a committed reservation updates the SAME row in place and
// never creates a duplicate. No transaction client is surfaced; the repository
// participates in the manager's unit of work automatically.

import { InventoryReservation } from "@api/domain/entities/InventoryReservation";

export interface IInventoryReservationRepository {
  findByKey(reservationKey: string): Promise<InventoryReservation | null>;
  /** All reservations for an order, ordered by (variant id, id) for stable replay. */
  findByOrder(orderId: string): Promise<InventoryReservation[]>;
  save(reservation: InventoryReservation): Promise<void>;
  /**
   * Insert a NEW reservation ONLY when its deterministic `reservation_key` does
   * not already exist. Returns true when inserted, false when a concurrent
   * transaction committed the same key first (the caller must then roll back
   * its own unit of work so the level decrement is undone, and replay the
   * winner's row). NEVER used to update an existing row — `save` owns that.
   */
  createIfAbsent(reservation: InventoryReservation): Promise<boolean>;
}