// apps/api/src/infrastructure/database/repositories/PostgresPaymentRepository.ts

// Postgres-backed implementation of IPaymentRepository.
//
// Persists durable payment obligations. The `payment` table is the FINAL
// concurrency guard for payment idempotency:
//   - partial UNIQUE(obligation_type, obligation_id) WHERE status <> 'failed'
//   — one ACTIVE obligation per business object; a fresh row is allowed once
//   the prior obligation has been reset to `failed` (migration 0010);
//   - UNIQUE(reference)                      — one app-generated idempotency key;
//   - UNIQUE(provider_reference)             — one provider transaction.
//
// save() inserts a new row and reconciles an EXISTING row (by id) in place so
// status transitions (initialized -> captured) persist provider references and
// the payment URL. A collision on the partial obligation index or the reference
// UNIQUE constraint is NOT an id-conflict update and therefore surfaces as
// RepositoryErrorCode.DUPLICATE, which the use-case layer turns into an
// idempotent replay instead of a second charge.

import {
  Payment,
  PaymentObligationType,
  PaymentState,
} from "@api-domain-entities/Payment";
import type { IPaymentRepository } from "@api-domain-interfaces/repositories/IPaymentRepository";
import { TransactionContext } from "../transaction/TransactionContext";
import { toRepositoryError } from "./errorMapping";

type PaymentRow = {
  id: string;
  obligation_type: string;
  obligation_id: string;
  reference: string;
  provider_reference: string | null;
  provider_payment_url: string | null;
  amount_minor: number;
  currency: string | null;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  shipping_minor: number;
  insurance_minor: number;
  status: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

function toDomain(row: PaymentRow): Payment {
  // Normalize the pre-transition state model: rows recorded as `initialized`
  // before the explicit INITIALIZATION_PENDING state existed, but never received
  // a provider payment URL (the gateway call never completed, or its result was
  // not persisted), are semantically PENDING. The domain invariant — a payment
  // is `initialized` iff it carries a provider payment URL — is preserved on
  // hydration.
  let status = row.status as PaymentState;
  if (status === "initialized" && !row.provider_payment_url) {
    status = "initialization_pending";
  }

  return new Payment({
    id: row.id,
    obligationType: row.obligation_type as PaymentObligationType,
    obligationId: row.obligation_id,
    reference: row.reference,
    providerReference: row.provider_reference,
    providerPaymentUrl: row.provider_payment_url,
    amountMinor: row.amount_minor,
    currency: row.currency,
    subtotalMinor: row.subtotal_minor,
    discountMinor: row.discount_minor,
    taxMinor: row.tax_minor,
    shippingMinor: row.shipping_minor,
    insuranceMinor: row.insurance_minor,
    status,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class PostgresPaymentRepository implements IPaymentRepository {
  constructor(private readonly context: TransactionContext) {}

  async findById(paymentId: string): Promise<Payment | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("payment")
        .selectAll()
        .where("id", "=", paymentId)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByReference(reference: string): Promise<Payment | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("payment")
        .selectAll()
        .where("reference", "=", reference)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByProviderReference(
    providerReference: string,
  ): Promise<Payment | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("payment")
        .selectAll()
        .where("provider_reference", "=", providerReference)
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async findByObligation(
    obligationType: PaymentObligationType,
    obligationId: string,
  ): Promise<Payment | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("payment")
        .selectAll()
        .where("obligation_type", "=", obligationType)
        .where("obligation_id", "=", obligationId)
        .orderBy("created_at", "desc")
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async countFailedByObligation(
    obligationType: PaymentObligationType,
    obligationId: string,
  ): Promise<number> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("payment")
        .select((eb) => eb.fn.countAll<number>().as("failed_count"))
        .where("obligation_type", "=", obligationType)
        .where("obligation_id", "=", obligationId)
        .where("status", "=", "failed")
        .executeTakeFirst();

      return Number(row?.failed_count ?? 0);
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async lockPaymentForUpdate(reference: string): Promise<Payment | null> {
    try {
      const row = await this.context
        .getDb()
        .selectFrom("payment")
        .selectAll()
        .where("reference", "=", reference)
        // Blocking FOR UPDATE (no NOWAIT): refund claims serialize on the
        // obligation row so the cumulative refund guard observes committed
        // refunds before validating, instead of racing.
        .forUpdate()
        .executeTakeFirst();

      return row ? toDomain(row) : null;
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }

  async save(payment: Payment): Promise<void> {
    try {
      await this.context
        .getDb()
        .insertInto("payment")
        .values({
          id: payment.id,
          obligation_type: payment.obligationType,
          obligation_id: payment.obligationId,
          reference: payment.reference,
          provider_reference: payment.providerReference,
          provider_payment_url: payment.providerPaymentUrl,
          amount_minor: payment.amountMinor,
          currency: payment.currency,
          subtotal_minor: payment.subtotalMinor,
          discount_minor: payment.discountMinor,
          tax_minor: payment.taxMinor,
          shipping_minor: payment.shippingMinor,
          insurance_minor: payment.insuranceMinor,
          status: payment.status,
          metadata: JSON.stringify(payment.metadata),
          created_at: payment.createdAt,
          updated_at: payment.updatedAt,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            provider_reference: payment.providerReference,
            provider_payment_url: payment.providerPaymentUrl,
            status: payment.status,
            metadata: JSON.stringify(payment.metadata),
            updated_at: payment.updatedAt,
          }),
        )
        .execute();
    } catch (err: unknown) {
      throw toRepositoryError(err);
    }
  }
}