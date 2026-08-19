// apps/api/src/infrastructure/database/transaction/TransactionContext.ts

// Infrastructure-level database access context.
//
// Provides the single resolution point repositories use to obtain a Kysely
// instance: inside an active transaction the transaction-scoped connection is
// returned; otherwise the global/pooled connection is used. This lets
// repositories participate in an ITransactionManager unit of work without
// accepting transaction parameters or leaking Kysely types into domain or
// application interfaces.
//
// The context is backed by AsyncLocalStorage so the active transaction is
// propagated implicitly through the async call stack of the unit of work.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../schema/types";

export class TransactionContext {
  private readonly storage = new AsyncLocalStorage<Transaction<Database>>();
  private readonly globalDb: Kysely<Database>;

  constructor(globalDb: Kysely<Database>) {
    this.globalDb = globalDb;
  }

  /**
   * Runs `work` with `trx` as the active transaction for its async scope.
   */
  run<T>(trx: Transaction<Database>, work: () => Promise<T>): Promise<T> {
    return this.storage.run(trx, work);
  }

  /**
   * Resolves the active transaction connection when inside a unit of work,
   * otherwise the global/pooled connection.
   */
  getDb(): Kysely<Database> {
    return this.storage.getStore() ?? this.globalDb;
  }

  /**
   * Returns the active transaction when inside a unit of work, else `null`.
   */
  getActiveTransaction(): Transaction<Database> | null {
    return this.storage.getStore() ?? null;
  }
}
