// apps/api/tests/fakes/InMemoryTransactionManager.ts

// A transaction manager whose unit of work is a plain awaited callback. The
// use cases under test delegate ALL multi-repository mutations to this
// abstraction; this fake preserves the contract (no repository-owning
// transactions) while avoiding Postgres.

import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";

export class InMemoryTransactionManager implements ITransactionManager {
  async execute<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}