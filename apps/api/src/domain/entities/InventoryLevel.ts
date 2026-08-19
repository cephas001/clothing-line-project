// apps/api/src/domain/entities/InventoryLevel.ts
//
// L9 — per-(variant, location) stock ledger (INV-I1 / INV-I2).
//
// The counters are guarded by DB CHECKs (>= 0) and the atomic conditional
// UPDATE is the final concurrency guard, but this entity keeps the same
// arithmetic as the single source of truth for the read model, in-memory
// fakes, and any future unit tests. All quantities are whole positive units;
// the entity rejects negative counters at construction and mutation.

import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface InventoryLevelProps {
  id: string;
  variantId: string;
  locationId: string;
  availableQuantity: number;
  reservedQuantity?: number;
  version?: number;
}

export class InventoryLevel {
  private readonly _id: string;
  private readonly _variantId: string;
  private readonly _locationId: string;
  private _availableQuantity: number;
  private _reservedQuantity: number;
  private _version: number;

  constructor(props: InventoryLevelProps) {
    const id = (props.id ?? "").trim();
    const variantId = (props.variantId ?? "").trim();
    const locationId = (props.locationId ?? "").trim();
    const availableQuantity = Number(props.availableQuantity);
    const reservedQuantity = Number(props.reservedQuantity ?? 0);
    const version = Number(props.version ?? 0);

    if (!id) {
      throw new DomainError("VALIDATION_ERROR", "Inventory level id is required.");
    }
    if (!variantId) {
      throw new DomainError("VALIDATION_ERROR", "Variant id is required.");
    }
    if (!locationId) {
      throw new DomainError("VALIDATION_ERROR", "Location id is required.");
    }
    if (
      !Number.isInteger(availableQuantity) ||
      availableQuantity < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "availableQuantity must be a non-negative integer.",
      );
    }
    if (
      !Number.isInteger(reservedQuantity) ||
      reservedQuantity < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "reservedQuantity must be a non-negative integer.",
      );
    }
    if (!Number.isInteger(version) || version < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "version must be a non-negative integer.",
      );
    }

    this._id = id;
    this._variantId = variantId;
    this._locationId = locationId;
    this._availableQuantity = availableQuantity;
    this._reservedQuantity = reservedQuantity;
    this._version = version;
  }

  get id(): string {
    return this._id;
  }

  get variantId(): string {
    return this._variantId;
  }

  get locationId(): string {
    return this._locationId;
  }

  get availableQuantity(): number {
    return this._availableQuantity;
  }

  get reservedQuantity(): number {
    return this._reservedQuantity;
  }

  get version(): number {
    return this._version;
  }

  /** A reservation is only possible while available stock covers the quantity (INV-I2). */
  canReserve(quantity: number): boolean {
    return this._availableQuantity >= quantity;
  }

  /** Move `quantity` units from available into reserved (INV-I1 / INV-I2). */
  reserveAvailable(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Reservation quantity must be a positive integer.",
      );
    }
    if (!this.canReserve(quantity)) {
      throw new DomainError(
        "INSUFFICIENT_INVENTORY",
        "Insufficient available inventory to reserve.",
      );
    }
    this._availableQuantity -= quantity;
    this._reservedQuantity += quantity;
    this._version += 1;
  }

  /** Return `quantity` reserved units to the available pool (INV-I6). */
  releaseReserved(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Release quantity must be a positive integer.",
      );
    }
    if (this._reservedQuantity < quantity) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot release more units than are reserved.",
      );
    }
    this._reservedQuantity -= quantity;
    this._availableQuantity += quantity;
    this._version += 1;
  }

  /** Consume `quantity` reserved units (order fulfilled); available unchanged (INV-I7). */
  confirmReserved(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Confirmation quantity must be a positive integer.",
      );
    }
    if (this._reservedQuantity < quantity) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot confirm more units than are reserved.",
      );
    }
    this._reservedQuantity -= quantity;
    this._version += 1;
  }
}