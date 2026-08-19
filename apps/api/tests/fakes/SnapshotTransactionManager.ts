// apps/api/tests/fakes/SnapshotTransactionManager.ts
//
// A deterministic ROLLBACK transaction manager for the atomicity tests.
//
// A real ITransactionManager opens a database transaction, runs the unit of
// work, and ROLLS BACK every write if the work throws — leaving zero partial
// state. The in-memory repositories cannot do that by themselves (and must
// not own transactions), so this fake snapshots every wrapped repository
// BEFORE the work and restores them on failure, exactly simulating the
// all-or-nothing guarantee the use cases rely on.
//
// On SUCCESS the snapshots are discarded (committed). Repositories expose
// snapshot()/restore() via the Snapshotable contract in cloneEntity.ts.

import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import type { Snapshotable } from "./cloneEntity";

export class SnapshotTransactionManager implements ITransactionManager {
  constructor(private readonly stores: Snapshotable[]) {}

  async execute<T>(work: () => Promise<T>): Promise<T> {
    const snapshots = this.stores.map((store) => store.snapshot());
    try {
      return await work();
    } catch (err: unknown) {
      // Roll back every repository to its pre-work state (all-or-nothing).
      this.stores.forEach((store, index) => store.restore(snapshots[index]));
      throw err;
    }
  }
}