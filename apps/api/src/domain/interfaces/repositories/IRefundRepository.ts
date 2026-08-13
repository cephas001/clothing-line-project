// apps/api/src/domain/interfaces/repositories/IRefundRepository.ts
import { Refund } from "@api-domain-entities/Refund";

/**
 * Persistence contract for durable, idempotent refunds.
 *
 * `save` enforces refund idempotency: an insert that collides on the UNIQUE
 * (provider_transaction_reference, amount_minor) or `refund_reference`
 * constraints surfaces RepositoryErrorCode.DUPLICATE, so the same refund can
 * never be issued twice. Updating an existing refund (by id) reconciles its
 * provider reference / status in place.
 */
export interface IRefundRepository {
  findById(refundId: string): Promise<Refund | null>;
  findByRefundReference(refundReference: string): Promise<Refund | null>;
  findByTransactionAndAmount(
    providerTransactionReference: string,
    amountMinor: number,
  ): Promise<Refund | null>;
  /**
   * Total amount already refunded (pending + dispatched) against the given
   * provider transaction reference, in integer minor units. Failed refunds
   * (never issued) are excluded. Runs against the current ITransactionManager
   * unit of work, so the sum is authoritative within the same transaction that
   * claims a new refund.
   */
  sumRefundedMinor(providerTransactionReference: string): Promise<number>;
  save(refund: Refund): Promise<void>;
}