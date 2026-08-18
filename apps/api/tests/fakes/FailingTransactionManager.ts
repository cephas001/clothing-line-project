// apps/api/tests/fakes/FailingTransactionManager.ts
//
// A transaction manager that injects a failure INSIDE the short receipt
// transaction — models a DB error while the worker persists `markDispatched`.
// `failNext` makes the next execute() throw (and clear), so a retry with a
// healthy manager can complete the same unit of work.

import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";

export class FailingTransactionManager implements ITransactionManager {
  failNext: Error | null = null;

  async execute<T>(work: () => Promise<T>): Promise<T> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    return work();
  }
}