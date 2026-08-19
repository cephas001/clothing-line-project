// apps/api/tests/fakes/DepthAwareBarrierTransactionManager.ts
//
// A deterministic RACE transaction manager for the concurrency tests that
// models Kysely's REAL nested-transaction semantics (verified against
// KyselyTransactionManager: a nested execute() re-participates in the active
// transaction and passes the work straight through — no savepoint, no rollback
// at the nested boundary).
//
// This fake gates ONLY the TOP-LEVEL execute() at the barrier until all
// `parties` have arrived, then releases them together — reproducing the
// check-then-write race the use cases handle intentionally — while NESTED
// execute() calls (the reservation unit inside the payment claim, the
// confirmation unit inside order finalization, the release unit inside the
// reset) pass straight through exactly like the real manager.
//
// Nesting is tracked PER CALL-CHAIN via AsyncLocalStorage (mirroring Kysely's
// per-request active-transaction context), NOT a shared depth counter: with
// concurrent top-level parties a shared counter is ambiguous — one party's
// increment would make the OTHER top-level party appear nested. Each party's
// execute() gates at the barrier exactly once.
//
// Like the original BarrierTransactionManager it performs NO rollback: the
// shared in-memory stores cannot model two isolated transactions, so rollback
// guarantees are exercised by the SnapshotTransactionManager suites instead.
// The inventory fakes additionally return PROTOTYPE-PRESERVING CLONES on reads
// and keep their atomic guards synchronous, so the racing actors never mutate
// each other's loaded instances and the losing createIfAbsent collides
// deterministically.

import { AsyncLocalStorage } from "node:async_hooks";
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";

const TRANSACTION_ACTIVE = Symbol("transaction-active");

export class DepthAwareBarrierTransactionManager implements ITransactionManager {
  private waiting: Array<() => void> = [];
  private readonly store = new AsyncLocalStorage<symbol>();

  constructor(private readonly parties = 2) {}

  async execute<T>(work: () => Promise<T>): Promise<T> {
    if (this.store.getStore() === TRANSACTION_ACTIVE) {
      // Nested (re-entrant) execute — same logical transaction, pass through.
      return work();
    }

    // Top-level execute: gate at the barrier until all parties arrive, then
    // release them together inside an active-transaction context so any nested
    // execute() this work performs passes straight through.
    return this.store.run(TRANSACTION_ACTIVE, async () => {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        if (this.waiting.length >= this.parties) {
          const releases = this.waiting.splice(0, this.parties);
          for (const release of releases) {
            release();
          }
        }
      });
      return await work();
    });
  }
}
