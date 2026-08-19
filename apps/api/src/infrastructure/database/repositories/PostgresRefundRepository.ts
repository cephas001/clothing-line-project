// apps/api/src/infrastructure/database/repositories/PostgresRefundRepository.ts

// Postgres-backed implementation of IRefundRepository.
//
// Persists durable, idempotent refund records. The `refund` table is the FINAL
// guard against double refunds:
//   - UNIQUE(provider_transaction_reference, amount_minor) — the same amount
//     against the same transaction can only be refunded once;
//   - UNIQUE(refund_reference)      — one app-generated idempotency key;
//   - UNIQUE(provider_refund_reference) — one provider refund.
//
// save() inserts a new row and reconciles an EXISTING row (by id) in place so
// status transitions (pending -> dispatched / failed) persist the provider
// refund reference. A collision on the transaction/amount or refund_reference
// unique constraints is NOT an id-conflict update and therefore surfaces as
// RepositoryErrorCode.DUPLICATE, which the use-case layer turns into an
// idempotent replay or a reconciliation-required outcome.

import { Refund, RefundStatus } from "@api-domain-entities/Refund";
import type { IRefundRepository } from "@api-domain-interfaces/repositories/IRefundRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type RefundRow = {
  id: string;
  payment_id: string | null;
  refund_reference: string;
  provider_refund_reference: string | null;
  provider_transaction_reference: string;
  amount_minor: number;
  currency: string | null;
  status: string;
  reason: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

function toDomain(row: RefundRow): Refund {
  return new Refund({
    id: row.id,
    paymentId: row.payment_id,
    refundReference: row.refund_reference,
    providerRefundReference: row.provider_refund_reference,
    providerTransactionReference: row.provider_transaction_reference,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status as RefundStatus,
    reason: row.reason,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class PostgresRefundRepository implements IRefundRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(refundId: string): Promise<Refund | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("refund")
        .selectAll()
        .where("id", "=", refundId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByRefundReference(refundReference: string): Promise<Refund | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("refund")
        .selectAll()
        .where("refund_reference", "=", refundReference)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByTransactionAndAmount(
    providerTransactionReference: string,
    amountMinor: number,
  ): Promise<Refund | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("refund")
        .selectAll()
        .where("provider_transaction_reference", "=", providerTransactionReference)
        .where("amount_minor", "=", amountMinor)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async sumRefundedMinor(
    providerTransactionReference: string,
  ): Promise<number> {
    try {
      const { total } =
        (await this.context
          .getDb()
          .selectFrom("refund")
          .select((eb) => eb.fn.sum<number>("amount_minor").as("total"))
          .where("provider_transaction_reference", "=", providerTransactionReference)
          .where("status", "!=", "failed")
          .executeTakeFirst()) ?? { total: null };

      return total ?? 0;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(refund: Refund): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("refund")
        .values({
          id: refund.id,
          payment_id: refund.paymentId,
          refund_reference: refund.refundReference,
          provider_refund_reference: refund.providerRefundReference,
          provider_transaction_reference: refund.providerTransactionReference,
          amount_minor: refund.amountMinor,
          currency: refund.currency,
          status: refund.status,
          reason: refund.reason,
          metadata: JSON.stringify(refund.metadata),
          created_at: refund.createdAt,
          updated_at: refund.updatedAt,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            provider_refund_reference: refund.providerRefundReference,
            status: refund.status,
            metadata: JSON.stringify(refund.metadata),
            updated_at: refund.updatedAt,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}