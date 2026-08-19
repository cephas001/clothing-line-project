// apps/api/tests/fakes/InMemoryTransactionRepository.ts

// In-memory ITransactionRepository keyed by reference (the payment idempotency
// key), mirroring the UNIQUE(transaction.reference) finalization guard: saving
// a transaction whose reference is already taken by a DIFFERENT transaction
// surfaces RepositoryErrorCode.DUPLICATE — the intentional unique-conflict race
// both finalizers resolve idempotently. Saving the SAME reference reconciles in
// place.

import { Transaction } from "@api/domain/entities/Transaction";
import type { ITransactionRepository } from "@api/domain/interfaces/repositories/ITransactionRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryTransactionRepository
  implements ITransactionRepository, Snapshotable
{
  private readonly transactions = new Map<string, Transaction>();

  /** Test-only: when set, the next save() throws a RepositoryError with this code. */
  failNextSaveWith?: RepositoryErrorCode;

  seed(transaction: Transaction): void {
    this.transactions.set(transaction.reference, transaction);
  }

  get all(): Transaction[] {
    return [...this.transactions.values()];
  }

  async findByReference(reference: string): Promise<Transaction | null> {
    return this.transactions.get(reference) ?? null;
  }

  async save(transaction: Transaction): Promise<void> {
    if (this.failNextSaveWith) {
      const code = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw this.repositoryError(code, "Injected repository failure.");
    }
    const existing = this.transactions.get(transaction.reference);
    if (existing) {
      // Reconcile in place (mirrors onConflict(reference) doUpdateSet).
      this.transactions.set(transaction.reference, transaction);
      return;
    }
    this.transactions.set(transaction.reference, transaction);
  }

  snapshot(): unknown {
    return cloneValue([...this.transactions.values()]);
  }

  restore(state: unknown): void {
    this.transactions.clear();
    for (const transaction of state as Transaction[]) {
      this.transactions.set(transaction.reference, transaction);
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