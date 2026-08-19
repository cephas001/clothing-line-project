// apps/api/src/domain/interfaces/repositories/IInventoryLevelRepository.ts
//
// L9 — persistence contract for the per-(variant, location) stock ledger
// (`inventory_level`).
//
// The atomic primitives (reserveAvailable / releaseReserved / confirmReserved)
// are the FINAL concurrency guard (INV-I1 / INV-I2 / INV-I6 / INV-I7). Each is
// a single conditional UPDATE executed against the row-locked level inside the
// current ITransactionManager unit of work:
//
//   reserveAvailable: available - q, reserved + q  WHERE available >= q
//   releaseReserved:  reserved - q, available + q  WHERE reserved >= q
//   confirmReserved:  reserved - q                WHERE reserved >= q
//
// A zero-row result (returns false) means the guard failed — never a negative
// counter (the DB CHECKs make oversell structurally impossible). Callers
// interpret false as INSUFFICIENT_INVENTORY (reserve) or as an idempotent
// no-op replay (release/confirm). No transaction client is surfaced; the
// repository participates in the manager's unit of work automatically.

import { InventoryLevel } from "@api/domain/entities/InventoryLevel";

export interface IInventoryLevelRepository {
  findByVariant(variantId: string): Promise<InventoryLevel[]>;
  findByVariantAndLocation(
    variantId: string,
    locationId: string,
  ): Promise<InventoryLevel | null>;
  save(level: InventoryLevel): Promise<void>;

  /**
   * Atomically move `quantity` units from available into reserved, ONLY when
   * available >= quantity. Returns false when insufficient (nothing changed).
   */
  reserveAvailable(
    locationId: string,
    variantId: string,
    quantity: number,
  ): Promise<boolean>;

  /**
   * Atomically return `quantity` reserved units to available, ONLY when
   * reserved >= quantity. Returns false when the units are already gone
   * (idempotent replay of a release).
   */
  releaseReserved(
    locationId: string,
    variantId: string,
    quantity: number,
  ): Promise<boolean>;

  /**
   * Atomically consume `quantity` reserved units (order fulfilled), ONLY when
   * reserved >= quantity. Returns false when the units are already consumed
   * (idempotent replay of a confirmation).
   */
  confirmReserved(
    locationId: string,
    variantId: string,
    quantity: number,
  ): Promise<boolean>;
}