// apps/api/tests/fakes/InMemoryInventoryLevelRepository.ts
//
// In-memory IInventoryLevelRepository for the L9 checkout/reservation suites.
//
// Faithfully mirrors the database guards: each atomic primitive is the same
// single conditional update as the Postgres implementation —
//
//   reserveAvailable: available - q, reserved + q  WHERE available >= q
//   releaseReserved:  reserved - q, available + q  WHERE reserved >= q
//   confirmReserved:  reserved - q                WHERE reserved >= q
//
// A zero-row result returns FALSE (nothing changed) — never a negative
// counter. Reads return PROTOTYPE-PRESERVING CLONES so a caller's sourcing
// read (InventoryLevel.canReserve) is stable and never mutates the stored
// ledger; the atomic primitives operate on the stored instances directly.
//
// Snapshotable: the rollback/atomicity tests wrap this store so a failed unit
// of work restores every level.

import { InventoryLevel } from "@api/domain/entities/InventoryLevel";
import type { IInventoryLevelRepository } from "@api/domain/interfaces/repositories/IInventoryLevelRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

function levelKey(locationId: string, variantId: string): string {
  return `${locationId}:${variantId}`;
}

export class InMemoryInventoryLevelRepository
  implements IInventoryLevelRepository, Snapshotable
{
  private readonly levels = new Map<string, InventoryLevel>();

  /** Test-only: when set, the next save() throws this code. */
  failNextSaveWith?: RepositoryErrorCode;

  seed(level: InventoryLevel): void {
    this.levels.set(levelKey(level.locationId, level.variantId), level);
  }

  get all(): InventoryLevel[] {
    return [...this.levels.values()];
  }

  async findByVariant(variantId: string): Promise<InventoryLevel[]> {
    const rows = [...this.levels.values()].filter(
      (l) => l.variantId === variantId,
    );
    return rows.map((l) => cloneValue(l));
  }

  async findByVariantAndLocation(
    variantId: string,
    locationId: string,
  ): Promise<InventoryLevel | null> {
    const row = this.levels.get(levelKey(locationId, variantId));
    return row ? cloneValue(row) : null;
  }

  async save(level: InventoryLevel): Promise<void> {
    if (this.failNextSaveWith) {
      const code = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw this.repositoryError(code, "Injected level save failure.");
    }
    this.levels.set(levelKey(level.locationId, level.variantId), level);
  }

  async reserveAvailable(
    locationId: string,
    variantId: string,
    quantity: number,
  ): Promise<boolean> {
    const level = this.levels.get(levelKey(locationId, variantId));
    if (!level || !level.canReserve(quantity)) {
      return false;
    }
    level.reserveAvailable(quantity);
    return true;
  }

  async releaseReserved(
    locationId: string,
    variantId: string,
    quantity: number,
  ): Promise<boolean> {
    const level = this.levels.get(levelKey(locationId, variantId));
    if (!level || level.reservedQuantity < quantity) {
      return false;
    }
    level.releaseReserved(quantity);
    return true;
  }

  async confirmReserved(
    locationId: string,
    variantId: string,
    quantity: number,
  ): Promise<boolean> {
    const level = this.levels.get(levelKey(locationId, variantId));
    if (!level || level.reservedQuantity < quantity) {
      return false;
    }
    level.confirmReserved(quantity);
    return true;
  }

  snapshot(): unknown {
    return cloneValue([...this.levels.values()]);
  }

  restore(state: unknown): void {
    this.levels.clear();
    for (const level of state as InventoryLevel[]) {
      this.levels.set(levelKey(level.locationId, level.variantId), level);
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