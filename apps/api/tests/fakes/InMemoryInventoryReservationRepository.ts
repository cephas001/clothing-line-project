// apps/api/tests/fakes/InMemoryInventoryReservationRepository.ts
//
// In-memory IInventoryReservationRepository for the L9 checkout/reservation
// suites.
//
// Faithfully mirrors the database guards:
//   - `save` upserts on the reservation id (ON CONFLICT (id) DO UPDATE).
//   - `createIfAbsent` is an atomic check-and-insert keyed on the deterministic
//     reservation_key — a concurrent duplicate returns false (INSERT ... ON
//     CONFLICT (reservation_key) DO NOTHING).
//   - Reads return PROTOTYPE-PRESERVING CLONES so concurrent actors never
//     mutate each other's loaded instances (a real transaction gives each actor
//     its own row snapshot).
//
// Snapshotable: the rollback/atomicity tests wrap this store so a failed unit
// of work restores every reservation row.

import { InventoryReservation } from "@api/domain/entities/InventoryReservation";
import type { IInventoryReservationRepository } from "@api/domain/interfaces/repositories/IInventoryReservationRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryInventoryReservationRepository
  implements IInventoryReservationRepository, Snapshotable
{
  private readonly byKey = new Map<string, InventoryReservation>();
  private readonly byId = new Map<string, InventoryReservation>();

  /** Test-only: when set, the next save()/createIfAbsent() throws this code. */
  failNextSaveWith?: RepositoryErrorCode;

  seed(reservation: InventoryReservation): void {
    this.byKey.set(reservation.reservationKey, reservation);
    this.byId.set(reservation.id, reservation);
  }

  get all(): InventoryReservation[] {
    return [...this.byId.values()];
  }

  async findByKey(reservationKey: string): Promise<InventoryReservation | null> {
    const row = this.byKey.get(reservationKey);
    return row ? cloneValue(row) : null;
  }

  async findByOrder(orderId: string): Promise<InventoryReservation[]> {
    const rows = [...this.byKey.values()]
      .filter((r) => r.orderId === orderId)
      .sort((a, b) =>
        a.variantId !== b.variantId
          ? a.variantId < b.variantId
            ? -1
            : 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
      );
    return rows.map((r) => cloneValue(r));
  }

  async save(reservation: InventoryReservation): Promise<void> {
    if (this.failNextSaveWith) {
      const code = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw this.repositoryError(code, "Injected reservation save failure.");
    }
    this.byKey.set(reservation.reservationKey, reservation);
    this.byId.set(reservation.id, reservation);
  }

  async createIfAbsent(reservation: InventoryReservation): Promise<boolean> {
    if (this.failNextSaveWith) {
      const code = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw this.repositoryError(code, "Injected reservation insert failure.");
    }
    // Atomic check-and-insert: no await between the check and the set, so two
    // callers can never interleave (mirrors ON CONFLICT DO NOTHING).
    if (this.byKey.has(reservation.reservationKey)) {
      return false;
    }
    this.byKey.set(reservation.reservationKey, reservation);
    this.byId.set(reservation.id, reservation);
    return true;
  }

  snapshot(): unknown {
    return cloneValue([...this.byId.values()]);
  }

  restore(state: unknown): void {
    this.byKey.clear();
    this.byId.clear();
    for (const reservation of state as InventoryReservation[]) {
      this.byKey.set(reservation.reservationKey, reservation);
      this.byId.set(reservation.id, reservation);
    }
  }

  private repositoryError(
    code: RepositoryErrorCode,
    message: string,
  ): RepositoryError {
    const error = new Error(message) as RepositoryError;
    error.name = "RepositoryError";
    error.code = code;
    return error;
  }
}