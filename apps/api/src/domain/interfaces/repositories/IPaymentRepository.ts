// apps/api/src/domain/interfaces/repositories/IPaymentRepository.ts
import { Payment, PaymentObligationType } from "@api-domain-entities/Payment";

/**
 * Persistence contract for durable payment obligations.
 *
 * `save` is the idempotency backstop: an insert that collides on the UNIQUE
 * (obligation_type, obligation_id) or `reference` constraints surfaces
 * RepositoryErrorCode.DUPLICATE, so a concurrent or retried initialization can
 * never create a second payment for the same obligation. Updating an existing
 * payment (by id) reconciles its provider reference / URL / status in place.
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