// apps/api/src/infrastructure/database/repositories/PostgresTransactionRepository.ts

// Postgres-backed implementation of ITransactionRepository.
//
// Persists payment transactions keyed by a unique gateway reference so payment
// events can be deduplicated idempotently (FinalizeOrderTransactionUseCase
// fast-fails when a reference already exists). created_at is a DB default; the
// entity's createdAt is only authoritative on reads.

import { Transaction } from "@api-domain-entities/Transaction";
import type { ITransactionRepository } from "@api-domain-interfaces/repositories/ITransactionRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type TransactionRow = {
  id: string;
  order_id: string;
  amount_minor: number;
  reference: string;
  created_at: string;
};

function toDomain(row: TransactionRow): Transaction {
  return new Transaction({
    id: row.id,
    orderId: row.order_id,
    amountMinor: row.amount_minor,
    reference: row.reference,
    createdAt: row.created_at,
  });
}

export class PostgresTransactionRepository implements ITransactionRepository {
  constructor(private readonly context: TransactionContext) {}

  async findByReference(reference: string): Promise<Transaction | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("transaction")
        .selectAll()
        .where("reference", "=", reference)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(transaction: Transaction): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("transaction")
        .values({
          id: transaction.id,
          order_id: transaction.orderId,
          amount_minor: transaction.amountMinor,
          reference: transaction.reference,
          created_at: transaction.createdAt,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            order_id: transaction.orderId,
            amount_minor: transaction.amountMinor,
            reference: transaction.reference,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}
