import { Transaction } from "@api-domain-entities/Transaction";

export interface ITransactionRepository {
  findByReference(reference: string): Promise<Transaction | null>;
  save(transaction: Transaction): Promise<void>;
}
