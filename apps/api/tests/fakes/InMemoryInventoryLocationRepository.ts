// apps/api/tests/fakes/InMemoryInventoryLocationRepository.ts
//
// In-memory IInventoryLocationRepository for the L9 checkout/reservation
// suites.
//
// Locations are immutable domain records (readonly fields); reads return
// PROTOTYPE-PRESERVING CLONES so callers can never alias the stored rows.
// `listActive` filters active nodes and orders by code (byte-wise) so the
// deterministic single-origin sourcing rule (INV-I8) is stable across runs.
//
// Snapshotable: the rollback/atomicity tests wrap this store so a failed unit
// of work restores every location row.

import { InventoryLocation } from "@api/domain/entities/InventoryLocation";
import type { IInventoryLocationRepository } from "@api/domain/interfaces/repositories/IInventoryLocationRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryInventoryLocationRepository
  implements IInventoryLocationRepository, Snapshotable
{
  private readonly locations = new Map<string, InventoryLocation>();

  /** Test-only: when set, the next save() throws this code. */
  failNextSaveWith?: RepositoryErrorCode;

  seed(location: InventoryLocation): void {
    this.locations.set(location.id, location);
  }

  get all(): InventoryLocation[] {
    return [...this.locations.values()];
  }

  async findById(id: string): Promise<InventoryLocation | null> {
    const row = this.locations.get(id);
    return row ? cloneValue(row) : null;
  }

  async findByCode(code: string): Promise<InventoryLocation | null> {
    const normalized = code.trim().toUpperCase();
    for (const row of this.locations.values()) {
      if (row.code === normalized) {
        return cloneValue(row);
      }
    }
    return null;
  }

  async listActive(): Promise<InventoryLocation[]> {
    const rows = [...this.locations.values()]
      .filter((l) => l.isActive)
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return rows.map((l) => cloneValue(l));
  }

  async save(location: InventoryLocation): Promise<void> {
    if (this.failNextSaveWith) {
      const code = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw this.repositoryError(code, "Injected location save failure.");
    }
    this.locations.set(location.id, location);
  }

  snapshot(): unknown {
    return cloneValue([...this.locations.values()]);
  }

  restore(state: unknown): void {
    this.locations.clear();
    for (const location of state as InventoryLocation[]) {
      this.locations.set(location.id, location);
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