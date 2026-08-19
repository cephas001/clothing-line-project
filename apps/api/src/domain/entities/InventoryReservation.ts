// apps/api/src/domain/entities/InventoryReservation.ts
//
// L9 — durable, idempotent inventory reservation.
//
// The reservation is the durable record of a successful atomic reserve. Its
// `reservationKey` is DETERMINISTIC (`reserve:${orderId}:${variantId}:${locationId}`)
// so a retried/concurrent duplicate collides at the database and the whole
// unit of work rolls back instead of double-reserving (INV-I3 / INV-I4).
//
// Lifecycle (state machine):
//   pending ──activate/reserve──> reserved ──confirm──> confirmed (terminal)
//                                    │──release──> released (terminal)
//                                    │──cancel───> cancelled (terminal)
//                                    │──expire───> expired   (terminal)
//   released | cancelled | expired ──reactivate──> reserved  (re-reservation)
//   confirmed is TERMINAL and can never be re-activated.
//
// The DB default status is 'pending' (legacy fallback for manual inserts only);
// the application always writes an explicit status.

import { DomainError } from "@api/domain/entities/errors/DomainError";

export type InventoryReservationStatus =
  | "pending"
  | "reserved"
  | "confirmed"
  | "released"
  | "cancelled"
  | "expired";

/** Statuses from which a reservation can never consume/release inventory again. */
export const TERMINAL_RESERVATION_STATUSES: readonly InventoryReservationStatus[] =
  ["confirmed", "released", "cancelled", "expired"] as const;

export interface InventoryReservationProps {
  id: string;
  reservationKey: string;
  locationId: string;
  variantId: string;
  quantity: number;
  status: InventoryReservationStatus;
  orderId?: string | null;
  expiresAt?: string | null;
  version?: number;
}

export class InventoryReservation {
  readonly id: string;
  readonly reservationKey: string;
  readonly locationId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly orderId: string | null;
  readonly expiresAt: string | null;

  private _status: InventoryReservationStatus;
  private _version: number;

  constructor(props: InventoryReservationProps) {
    const id = (props.id ?? "").trim();
    const reservationKey = (props.reservationKey ?? "").trim();
    const locationId = (props.locationId ?? "").trim();
    const variantId = (props.variantId ?? "").trim();
    const quantity = Number(props.quantity);
    const version = Number(props.version ?? 0);
    const status = props.status ?? "pending";

    if (!id) {
      throw new DomainError("VALIDATION_ERROR", "Reservation id is required.");
    }
    if (!reservationKey) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Reservation key is required.",
      );
    }
    if (!locationId) {
      throw new DomainError("VALIDATION_ERROR", "Location id is required.");
    }
    if (!variantId) {
      throw new DomainError("VALIDATION_ERROR", "Variant id is required.");
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Reservation quantity must be a positive integer.",
      );
    }
    if (!isInventoryReservationStatus(status)) {
      throw new DomainError("VALIDATION_ERROR", `Unknown reservation status: ${status}.`);
    }
    if (!Number.isInteger(version) || version < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "version must be a non-negative integer.",
      );
    }

    this.id = id;
    this.reservationKey = reservationKey;
    this.locationId = locationId;
    this.variantId = variantId;
    this.quantity = quantity;
    this.orderId = (props.orderId ?? "").trim() || null;
    this.expiresAt = props.expiresAt ?? null;
    this._status = status;
    this._version = version;
  }

  get status(): InventoryReservationStatus {
    return this._status;
  }

  get version(): number {
    return this._version;
  }

  /** Units are currently deducted from available and held in the reserved bucket. */
  get isHeld(): boolean {
    return this._status === "reserved";
  }

  get isTerminal(): boolean {
    return TERMINAL_RESERVATION_STATUSES.includes(this._status);
  }

  private transitionTo(
    target: InventoryReservationStatus,
    allowedFrom: readonly InventoryReservationStatus[],
  ): void {
    if (!allowedFrom.includes(this._status)) {
      throw new DomainError(
        "INVALID_STATUS_TRANSITION",
        `Cannot transition reservation from '${this._status}' to '${target}'.`,
      );
    }
    this._status = target;
    this._version += 1;
  }

  /** reserved -> confirmed: the order was fulfilled; the held units are consumed (INV-I7). */
  confirm(): void {
    this.transitionTo("confirmed", ["reserved"]);
  }

  /** reserved -> released: held units are returned to the available pool (INV-I6). */
  release(): void {
    this.transitionTo("released", ["reserved"]);
  }

  /** reserved | pending -> cancelled: operator-initiated cancellation of the hold. */
  cancel(): void {
    this.transitionTo("cancelled", ["reserved", "pending"]);
  }

  /** reserved | pending -> expired: the hold TTL elapsed; units returned. */
  expire(): void {
    this.transitionTo("expired", ["reserved", "pending"]);
  }

  /**
   * Reactivate a terminal (released/cancelled/expired) reservation back to
   * `reserved` for a re-reservation of the SAME deterministic key. `confirmed`
   * is terminal and can never be reactivated (the units were already consumed
   * at fulfillment). Idempotent when already reserved.
   */
  reactivate(): void {
    if (this._status === "reserved") {
      return;
    }
    if (this._status === "pending") {
      this._status = "reserved";
      this._version += 1;
      return;
    }
    this.transitionTo("reserved", ["released", "cancelled", "expired"]);
  }
}

function isInventoryReservationStatus(
  value: string,
): value is InventoryReservationStatus {
  return (
    value === "pending" ||
    value === "reserved" ||
    value === "confirmed" ||
    value === "released" ||
    value === "cancelled" ||
    value === "expired"
  );
}