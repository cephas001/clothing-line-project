// apps/api/tests/fakes/BarrierTransactionManager.ts
//
// A deterministic RACE transaction manager for the concurrency tests.
//
// Two (or `parties`) concurrent use-case invocations each call
// transactionManager.execute() for their write unit of work. Without a
// barrier, a single-threaded event loop interleaves them unpredictably — the
// first may fully commit before the second even starts, so the UNIQUE-conflict
// race path never triggers.
//
// This fake holds every execute() at the boundary until ALL `parties` have
// arrived, then releases them together. Both callers therefore run their
// check-then-write logic CONCURRENTLY against the same initial state and the
// loser deterministically collides on the UNIQUE constraints the fakes
// enforce — reproducing the exact race FinalizeOrderTransactionUseCase and
// InitializePaymentSessionUseCase handle intentionally.

import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";

export class BarrierTransactionManager implements ITransactionManager {
  private waiting: Array<() => void> = [];

  constructor(private readonly parties = 2) {}

  async execute<T>(work: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length >= this.parties) {
        const releases = this.waiting.splice(0, this.parties);
        for (const release of releases) {
          release();
        }
      }
    });
    return work();
  }
}