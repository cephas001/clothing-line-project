// apps/api/src/domain/entities/Transaction.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";

export interface TransactionProps {
  id: string;
  orderId: string;
  amountMinor: number;
  reference: string;
  createdAt?: string; // Optional timestamp for transaction creation
}

export class Transaction {
  readonly id: string;
  readonly orderId: string;
  readonly amountMinor: number; // Integer normalization rule applied
  readonly reference: string;
  readonly createdAt: string; // Timestamp for transaction creation

  constructor(props: TransactionProps) {
    if (!props.reference || props.reference.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Transaction must possess a valid gateway reference.",
      );
    }
    if (!Number.isInteger(props.amountMinor) || props.amountMinor <= 0) {
      throw new DomainError(
        "NEGATIVE_AMOUNT",
        "Transaction amount must be a strictly positive integer.",
      );
    }

    this.id = props.id;
    this.orderId = props.orderId;
    this.amountMinor = props.amountMinor;
    this.reference = props.reference;
    this.createdAt = props.createdAt || new Date().toISOString();
  }
}
