// apps/api/src/infrastructure/database/transaction/KyselyTransactionManager.ts

// Kysely/PostgreSQL implementation of ITransactionManager.
//
// The single authoritative transaction orchestration mechanism: use cases
// declare a unit of work via ITransactionManager.execute(...) and every
// repository call within it resolves the same transaction-scoped connection
// through the injected TransactionContext.
//
// Kysely commits the transaction when `work` resolves and rolls it back when
// `work` throws, rethrowing the original error so application-layer error
// mapping (e.g. RepositoryError -> DomainError) is preserved. Nested
// execute() calls re-participate in the already-active transaction.

import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import type { Kysely } from "kysely";
import type { Database } from "../schema/types";
import { TransactionContext } from "./TransactionContext";

export class KyselyTransactionManager implements ITransactionManager {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly context: TransactionContext,
  ) {}

  async execute<T>(work: () => Promise<T>): Promise<T> {
    const active = this.context.getActiveTransaction();

    // Already inside a unit of work: participate in the existing transaction
    // rather than opening a nested one (Kysely transactions cannot nest).
    if (active) {
      return work();
    }

    return this.db.transaction().execute(async (trx) => {
      return this.context.run(trx, work);
    });
  }
}
