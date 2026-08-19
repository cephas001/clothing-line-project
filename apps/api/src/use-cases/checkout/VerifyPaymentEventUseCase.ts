// apps/api/src/use-cases/checkout/VerifyPaymentEventUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Payment } from "@api/domain/entities/Payment";
import type { IPaymentRepository } from "@api/domain/interfaces/repositories/IPaymentRepository";
import type { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import type { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: verify a confirmed payment event against the DURABLE payment
 * obligation BEFORE any financial finalization.
 *
 * The gateway webhook signature proves the payload came from the gateway — it
 * does NOT prove the payment is financially correct. The provider webhook is
 * never the source of truth for what the customer was supposed to pay; the
 * durable payment obligation persisted at initialization is. This use case
 * re-validates the queued event against PostgreSQL (authoritative) and rejects
 * any mismatch:
 *
 *   1. REFERENCE   — the webhook reference resolves to our payment obligation
 *                    (by app reference, then provider reference).
 *   2. CONTEXT     — the obligation belongs to the expected checkout context
 *                    (obligationType === "checkout", obligationId === cartId).
 *   3. AMOUNT      — the captured amount equals the obligation's amountMinor
 *                    exactly (no underpayments, no rounding, no conversion).
 *   4. CURRENCY    — the provider-reported currency equals the obligation's
 *                    currency exactly (case-insensitive; no normalization).
 *   5. STATE       — the obligation is in an acceptable success state
 *                    (initialization_pending / initialized / captured), not a
 *                    settled-away state (failed / refunded / partially_refunded).
 *
 * Failure codes:
 *   - PAYMENT_VERIFICATION_FAILED — reference/context/state mismatch (terminal;
 *     retrying cannot change the outcome). A reference that resolves to NO
 *     durable obligation (legacy/foreign/unknown) always fails closed with this
 *     code — a signed webhook alone is never sufficient.
 *   - INVALID_PAYMENT_AMOUNT      — captured amount mismatch (terminal).
 *   - INVALID_CURRENCY            — currency mismatch (terminal).
 *
 * Idempotency (1J): this verification is a gate, not the idempotency guard.
 * It runs BEFORE FinalizeOrderTransactionUseCase, which keeps its own
 * PostgreSQL-backed idempotency (UNIQUE order.transaction_reference /
 * transaction.reference). A duplicate event for an already-captured obligation
 * passes verification (captured is acceptable) and finalize resolves the
 * existing order. PostgreSQL remains authoritative; the Redis queue dedup
 * (jobId = transactionReference) is only a fast-path.
 */
export interface VerifyPaymentEventInput {
  cartId: string;
  transactionReference: string;
  /** Amount captured per the provider webhook, in integer minor units. */
  amountPaidMinor: number;
  /** Currency as reported by the provider webhook (lowercase). */
  reportedCurrency?: string | null;
  /** Authoritative expected amount captured at webhook time (obligation). */
  expectedAmountMinor?: number | null;
  actorId?: string;
}

/** States in which a charge.success may be financially finalized. */
const ACCEPTABLE_SUCCESS_STATES: ReadonlySet<Payment["status"]> = new Set([
  "initialization_pending",
  "initialized",
  "captured",
]);

export class VerifyPaymentEventUseCase {
  constructor(
    private readonly paymentRepository: IPaymentRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: VerifyPaymentEventInput): Promise<void> {
    const cartId = (input.cartId ?? "").trim();
    const transactionReference = (input.transactionReference ?? "").trim();
    const amountPaidMinor = Number(input.amountPaidMinor);
    const reportedCurrency = (input.reportedCurrency ?? "").trim() || null;
    const expectedAmountMinor = input.expectedAmountMinor ?? null;
    const actorId = (input.actorId ?? "").trim() || "system";

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!transactionReference) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "transactionReference is required.",
      );
    }
    if (!Number.isSafeInteger(amountPaidMinor) || amountPaidMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "amountPaidMinor must be a non-negative integer in minor units.",
      );
    }

    // --- Resolve the DURABLE obligation from PostgreSQL (authoritative) ------
    // The queued payload's expected amount/currency are cached at webhook time;
    // the FRESH obligation row is the source of financial truth.
    let payment: Payment | null;
    try {
      payment =
        (await this.paymentRepository.findByReference(transactionReference)) ??
        (await this.paymentRepository.findByProviderReference(
          transactionReference,
        ));
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to resolve payment obligation during financial verification",
        { err, transactionReference, cartId },
      );
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while resolving payment obligation.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while resolving payment obligation.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to resolve payment obligation.",
      );
    }

    // --- No durable obligation: fail CLOSED (permanent verification failure) --
    // Every payable webhook MUST resolve to a durable payment obligation. A
    // signed legacy webhook with an unknown reference is NEVER treated as
    // sufficient: there is no authoritative amount/currency/context to verify
    // against, and finalization must not reconstruct one from the current cart.
    // This is terminal — retrying cannot change the outcome.
    if (!payment) {
      this.logger.warn(
        "Payment event references an unknown payment reference; refusing to finalize",
        { cartId, transactionReference },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Payment reference does not resolve to a durable payment obligation.",
      );
    }

    // --- 1 + 2. REFERENCE (implicitly resolved) + CONTEXT -------------------
    if (
      payment.obligationType !== "checkout" ||
      payment.obligationId.trim() !== cartId
    ) {
      this.logger.warn(
        "Payment event does not belong to the expected checkout context",
        {
          cartId,
          transactionReference,
          obligationType: payment.obligationType,
          obligationId: payment.obligationId,
        },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Payment event does not match the expected checkout obligation.",
      );
    }

    // The queued event's cached expectation must agree with the fresh
    // obligation; a stale/corrupt payload is a terminal data anomaly.
    if (
      expectedAmountMinor !== null &&
      expectedAmountMinor !== payment.amountMinor
    ) {
      this.logger.warn(
        "Queued payment event expected amount is stale versus the durable obligation",
        {
          cartId,
          transactionReference,
          expectedAmountMinor,
          obligationAmountMinor: payment.amountMinor,
        },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Payment event expectation is stale versus the durable obligation.",
      );
    }

    // --- 3. AMOUNT — exact match; never an underpayment, rounding, or unit ---
    if (amountPaidMinor !== payment.amountMinor) {
      this.logger.warn(
        "Captured amount does not match the durable obligation; refusing to finalize",
        {
          cartId,
          transactionReference,
          amountPaidMinor,
          expectedAmountMinor: payment.amountMinor,
        },
      );
      throw new DomainError(
        "INVALID_PAYMENT_AMOUNT",
        "Captured amount does not match the payment obligation amount.",
      );
    }

    // --- 4. CURRENCY — exact match; no normalization or conversion -----------
    if (
      payment.currency &&
      reportedCurrency &&
      payment.currency.toLowerCase() !== reportedCurrency.toLowerCase()
    ) {
      this.logger.warn(
        "Reported currency does not match the durable obligation; refusing to finalize",
        {
          cartId,
          transactionReference,
          reportedCurrency,
          obligationCurrency: payment.currency,
        },
      );
      throw new DomainError(
        "INVALID_CURRENCY",
        "Reported currency does not match the payment obligation currency.",
      );
    }

    // --- 5. STATE — acceptable success state for finalization ---------------
    if (!ACCEPTABLE_SUCCESS_STATES.has(payment.status)) {
      this.logger.warn(
        "Payment obligation is in an unacceptable state for finalization",
        {
          cartId,
          transactionReference,
          paymentStatus: payment.status,
        },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Payment obligation is not in an acceptable state for finalization.",
      );
    }

    await this.auditVerified(
      actorId,
      cartId,
      transactionReference,
      payment.amountMinor,
    );
    this.logger.info("Payment event verified against the durable obligation", {
      cartId,
      transactionReference,
      amountMinor: payment.amountMinor,
      currency: payment.currency ?? undefined,
      paymentStatus: payment.status,
    });
  }

  private async auditVerified(
    actorId: string,
    cartId: string,
    transactionReference: string,
    amountMinor: number | null,
  ): Promise<void> {
    try {
      await this.auditLogService.logAction(
        actorId,
        "PAYMENT_EVENT_VERIFIED",
        {
          auditId: this.idGenerator.generate(),
          cartId,
          transactionReference,
          amountMinor: amountMinor === null ? null : String(amountMinor),
          verifiedAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn(
        "Audit log failed for payment event verification",
        { err: auditErr, cartId, transactionReference },
      );
    }
  }
}
