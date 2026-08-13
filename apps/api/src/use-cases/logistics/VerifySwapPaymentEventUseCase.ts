// apps/api/src/use-cases/logistics/VerifySwapPaymentEventUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Payment } from "@api/domain/entities/Payment";
import { Swap } from "@api/domain/entities/Swap";
import type { IPaymentRepository } from "@api/domain/interfaces/repositories/IPaymentRepository";
import type { ISwapRepository } from "@api/domain/interfaces/repositories/ISwapRepository";
import type { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import type { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: verify a confirmed swap-upcharge payment event against the DURABLE
 * payment obligation BEFORE any financial finalization.
 *
 * This is the swap counterpart of VerifyPaymentEventUseCase and mirrors its
 * architecture: a valid gateway webhook signature proves the payload came from
 * the gateway, NOT that the payment is financially correct. The durable payment
 * obligation persisted at initialization is the source of financial truth. This
 * use case re-validates the queued event against PostgreSQL (authoritative) and
 * rejects any mismatch:
 *
 *   1. REFERENCE   — the webhook reference resolves to our payment obligation
 *                    (by app reference, then provider reference).
 *   2. CONTEXT     — the obligation is a SWAP obligation
 *                    (obligationType === "swap").
 *   3. IDENTITY    — the obligation identity resolves to the correct swap row
 *                    (payment.obligationId === swap.id) whose order matches the
 *                    claimed order (swap.orderId === payload orderId).
 *   4. AMOUNT      — the captured amount equals the obligation's amountMinor
 *                    exactly (no underpayments, no rounding, no conversion).
 *   5. CURRENCY    — the provider-reported currency equals the obligation's
 *                    frozen currency exactly (required, case-insensitive).
 *   6. STATE       — the obligation is in an acceptable swap-payment success
 *                    state (initialization_pending / initialized / captured),
 *                    and the swap is not canceled.
 *
 * Failure codes:
 *   - PAYMENT_VERIFICATION_FAILED — reference/context/identity/state mismatch
 *     (terminal; retrying cannot change the outcome).
 *   - INVALID_PAYMENT_AMOUNT      — captured amount mismatch (terminal).
 *   - INVALID_CURRENCY            — currency mismatch or missing (terminal).
 *
 * Idempotency: this verification is a gate, not the idempotency guard. It runs
 * BEFORE FinalizeSwapTransactionUseCase, which owns the PostgreSQL-backed
 * idempotency (UNIQUE transaction.reference). A duplicate event for an
 * already-captured obligation passes verification (captured is acceptable) and
 * finalization resolves idempotently. PostgreSQL remains authoritative; the
 * Redis queue dedup (jobId = transactionReference) is only a fast-path.
 */
export interface VerifySwapPaymentEventInput {
  swapId: string;
  orderId: string;
  transactionReference: string;
  /** Amount captured per the provider webhook, in integer minor units. */
  amountPaidMinor: number;
  /** Currency as reported by the provider webhook (lowercase). */
  reportedCurrency?: string | null;
  /** Authoritative expected amount captured at webhook time (obligation). */
  expectedAmountMinor?: number | null;
  actorId?: string;
}

/** States in which a swap charge.success may be financially finalized. */
const ACCEPTABLE_PAYMENT_STATES: ReadonlySet<Payment["status"]> = new Set([
  "initialization_pending",
  "initialized",
  "captured",
]);

export class VerifySwapPaymentEventUseCase {
  constructor(
    private readonly paymentRepository: IPaymentRepository,
    private readonly swapRepository: ISwapRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: VerifySwapPaymentEventInput): Promise<void> {
    const swapId = (input.swapId ?? "").trim();
    const orderId = (input.orderId ?? "").trim();
    const transactionReference = (input.transactionReference ?? "").trim();
    const amountPaidMinor = Number(input.amountPaidMinor);
    const reportedCurrency = (input.reportedCurrency ?? "").trim() || null;
    const expectedAmountMinor = input.expectedAmountMinor ?? null;
    const actorId = (input.actorId ?? "").trim() || "system";

    if (!swapId) {
      throw new DomainError("VALIDATION_ERROR", "swapId is required.");
    }
    if (!orderId) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
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

    // --- 1. Resolve the DURABLE obligation from PostgreSQL (authoritative) -----
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
        "Failed to resolve payment obligation during swap financial verification",
        { err, transactionReference, swapId },
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

    // --- No durable obligation ------------------------------------------------
    // A swap upcharge has NO legacy (pre-foundation) flow: every swap obligation
    // is durable. An event that references no obligation is a terminal data
    // anomaly retrying cannot fix.
    if (!payment) {
      this.logger.warn(
        "Swap payment event references an obligation that does not resolve; refusing to finalize",
        { swapId, orderId, transactionReference },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Swap payment obligation referenced by the event could not be resolved.",
      );
    }

    // --- 2 + 3. CONTEXT + IDENTITY -------------------------------------------
    if (payment.obligationType !== "swap") {
      this.logger.warn(
        "Payment event is not a swap obligation; refusing to finalize swap",
        {
          swapId,
          transactionReference,
          obligationType: payment.obligationType,
          obligationId: payment.obligationId,
        },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Payment event does not reference a swap obligation.",
      );
    }

    if (payment.obligationId.trim() !== swapId) {
      this.logger.warn(
        "Swap payment event obligation identity does not match the claimed swap",
        {
          swapId,
          transactionReference,
          obligationId: payment.obligationId,
        },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Payment event does not match the claimed swap identity.",
      );
    }

    let swap: Swap | null;
    try {
      swap = await this.swapRepository.findById(payment.obligationId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to resolve swap during financial verification", {
        err,
        swapId,
        transactionReference,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while resolving swap.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while resolving swap.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to resolve swap.");
    }

    if (!swap) {
      this.logger.warn(
        "Swap obligation identity does not resolve to a swap row; refusing to finalize",
        { swapId, orderId, transactionReference },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Swap obligation identity does not resolve to a known swap.",
      );
    }
    if (swap.orderId.trim() !== orderId) {
      this.logger.warn(
        "Swap payment event order does not match the swap's order",
        {
          swapId,
          transactionReference,
          claimedOrderId: orderId,
          swapOrderId: swap.orderId,
        },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Swap payment event does not match the swap's order.",
      );
    }

    // The queued event's cached expectation must agree with the fresh
    // obligation; a stale/corrupt payload is a terminal data anomaly.
    if (
      expectedAmountMinor !== null &&
      expectedAmountMinor !== payment.amountMinor
    ) {
      this.logger.warn(
        "Queued swap payment event expected amount is stale versus the durable obligation",
        {
          swapId,
          transactionReference,
          expectedAmountMinor,
          obligationAmountMinor: payment.amountMinor,
        },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Swap payment event expectation is stale versus the durable obligation.",
      );
    }

    // --- 4. AMOUNT — exact match; never an underpayment, rounding, or unit ---
    if (amountPaidMinor !== payment.amountMinor) {
      this.logger.warn(
        "Captured amount does not match the swap payment obligation; refusing to finalize",
        {
          swapId,
          transactionReference,
          amountPaidMinor,
          expectedAmountMinor: payment.amountMinor,
        },
      );
      throw new DomainError(
        "INVALID_PAYMENT_AMOUNT",
        "Captured amount does not match the swap payment obligation amount.",
      );
    }

    // --- 5. CURRENCY — exact match, REQUIRED for a swap obligation ------------
    // The swap obligation always carries a frozen currency (Part 1). A missing
    // or mismatched provider-reported currency is a permanent rejection.
    if (!reportedCurrency) {
      this.logger.warn(
        "Swap payment event reported no currency; refusing to finalize",
        { swapId, transactionReference, obligationCurrency: payment.currency },
      );
      throw new DomainError(
        "INVALID_CURRENCY",
        "Swap payment event reported no currency.",
      );
    }
    if (
      (payment.currency ?? "").toLowerCase() !== reportedCurrency.toLowerCase()
    ) {
      this.logger.warn(
        "Reported currency does not match the swap payment obligation; refusing to finalize",
        {
          swapId,
          transactionReference,
          reportedCurrency,
          obligationCurrency: payment.currency,
        },
      );
      throw new DomainError(
        "INVALID_CURRENCY",
        "Reported currency does not match the swap payment obligation currency.",
      );
    }

    // --- 6. STATE — acceptable swap-payment + swap states ---------------------
    if (!ACCEPTABLE_PAYMENT_STATES.has(payment.status)) {
      this.logger.warn(
        "Swap payment obligation is in an unacceptable state for finalization",
        {
          swapId,
          transactionReference,
          paymentStatus: payment.status,
        },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Swap payment obligation is not in an acceptable state for finalization.",
      );
    }

    if (swap.status === "canceled") {
      this.logger.warn(
        "Swap is canceled; refusing to finalize its payment",
        { swapId, transactionReference, swapStatus: swap.status },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Swap is canceled and cannot be finalized.",
      );
    }

    await this.auditVerified(
      actorId,
      swapId,
      orderId,
      transactionReference,
      payment.amountMinor,
    );
    this.logger.info(
      "Swap payment event verified against the durable obligation",
      {
        swapId,
        orderId,
        transactionReference,
        amountMinor: payment.amountMinor,
        currency: payment.currency ?? undefined,
        paymentStatus: payment.status,
        swapStatus: swap.status,
      },
    );
  }

  private async auditVerified(
    actorId: string,
    swapId: string,
    orderId: string,
    transactionReference: string,
    amountMinor: number,
  ): Promise<void> {
    try {
      await this.auditLogService.logAction(
        actorId,
        "SWAP_PAYMENT_EVENT_VERIFIED",
        {
          auditId: this.idGenerator.generate(),
          swapId,
          orderId,
          transactionReference,
          amountMinor: String(amountMinor),
          verifiedAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn(
        "Audit log failed for swap payment event verification",
        { err: auditErr, swapId, transactionReference },
      );
    }
  }
}