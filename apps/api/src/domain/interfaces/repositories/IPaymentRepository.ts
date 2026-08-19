// apps/api/src/domain/interfaces/repositories/IPaymentRepository.ts
import { Payment, PaymentObligationType } from "@api-domain-entities/Payment";

/**
 * Persistence contract for durable payment obligations.
 *
 * `save` is the idempotency backstop: an insert that collides on the UNIQUE
 * `reference` constraint or the partial obligation-unique index surfaces
 * RepositoryErrorCode.DUPLICATE, so a concurrent or retried initialization can
 * never create a second ACTIVE payment for the same obligation. After a failed
 * obligation has been reset to `failed`, a fresh obligation row may be created
 * (see migration 0010). `findByObligation` returns the MOST RECENT row for the
 * obligation (the active one when it exists, otherwise the most recently
 * failed one). Updating an existing payment (by id) reconciles its provider
 * reference / URL / status in place.
 */
export interface IPaymentRepository {
  findById(paymentId: string): Promise<Payment | null>;
  findByReference(reference: string): Promise<Payment | null>;
  findByProviderReference(providerReference: string): Promise<Payment | null>;
  findByObligation(
    obligationType: PaymentObligationType,
    obligationId: string,
  ): Promise<Payment | null>;
  /**
   * Count the payment rows previously claimed for the obligation that are in
   * the `failed` state. With the partial obligation-unique index (migration
   * 0010) these are exactly the prior RESET attempts: the number is used to
   * derive a deterministic, per-attempt idempotency reference so a retry never
   * re-uses a reference that already produced a (possibly different-amount)
   * gateway transaction, while UNIQUE(reference) stays intact.
   */
  countFailedByObligation(
    obligationType: PaymentObligationType,
    obligationId: string,
  ): Promise<number>;
  /**
   * Acquire a row-level lock on the payment for the given app reference within
   * the transaction established by the current ITransactionManager. Runs inside
   * the manager's unit of work; no transaction client is surfaced to callers.
   *
   * Unlike the variant NOWAIT lock, this blocks (FOR UPDATE) so refund claims
   * against the same captured obligation serialize on the row: a concurrent
   * claim waits for the lock, then observes prior committed refunds before
   * deciding. Returns null when no row matches the reference.
   */
  lockPaymentForUpdate(reference: string): Promise<Payment | null>;
  save(payment: Payment): Promise<void>;
}