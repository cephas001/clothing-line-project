// apps/api/src/use-cases/logistics/FinalizeSwapTransactionUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Order } from "@api/domain/entities/Order";
import { Payment } from "@api/domain/entities/Payment";
import { Swap } from "@api/domain/entities/Swap";
import { Transaction } from "@api/domain/entities/Transaction";
import type { ISwapRepository } from "@api/domain/interfaces/repositories/ISwapRepository";
import type { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import type { IPaymentRepository } from "@api/domain/interfaces/repositories/IPaymentRepository";
import type { ITransactionRepository } from "@api/domain/interfaces/repositories/ITransactionRepository";
import type { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import type { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { ConfirmInventoryReservationUseCase } from "@api/use-cases/inventory/ConfirmInventoryReservationUseCase";

/**
 * Use case: finalize a confirmed swap after a successful upcharge payment event.
 *
 * Runs ONLY after VerifySwapPaymentEventUseCase (financial verification gate).
 * The HTTP webhook never touches swap/order state; this use case is invoked by
 * the PaymentEventWorker.
 *
 * Idempotency (authoritative = PostgreSQL):
 * - `transaction.reference` is UNIQUE. The upcharge ledger record is inserted
 *   with `reference = transactionReference` (the swap payment reference) inside
 *   the atomic unit of work, so a duplicate webhook, BullMQ retry, worker crash,
 *   or concurrent delivery collides there and the whole unit of work rolls back.
 *   The loser resolves the already-committed swap idempotently. The Redis/BullMQ
 *   dedup (jobId = transactionReference) is only a fast-path.
 * - `payment` (obligation_type, obligation_id) and `payment.reference` are also
 *   UNIQUE; `payment.markCaptured()` is idempotent for an already-captured row.
 *
 * Atomicity (ITransactionManager): swap state transition, order modification,
 * replacement-item inventory confirmation, payment capture, and the ledger
 * record all commit or all roll back together. If the unit of work fails, NO
 * partial swap is applied. The SWAP_FINALIZED audit is a non-blocking side
 * effect written AFTER the transaction resolves (it never participates in the
 * atomic unit, matching the checkout finalization convention).
 *
 * Money integrity: the amount captured (verified upstream against the durable
 * obligation) is re-checked defensively here; the swap's frozen variance drives
 * the order adjustment and the ledger record. The order total is adjusted ONLY
 * by the swap variance, preserving the order's frozen financial structure.
 */
export interface FinalizeSwapTransactionInput {
  swapId: string;
  orderId: string;
  transactionReference: string;
  amountPaidMinor: number;
  currency?: string | null;
  expectedAmountMinor?: number | null;
  actorId?: string;
}

export class FinalizeSwapTransactionUseCase {
  constructor(
    private readonly swapRepository: ISwapRepository,
    private readonly orderRepository: IOrderRepository,
    private readonly paymentRepository: IPaymentRepository,
    private readonly transactionRepository: ITransactionRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
    private readonly confirmInventoryReservation: ConfirmInventoryReservationUseCase,
  ) {}

  async execute(input: FinalizeSwapTransactionInput): Promise<Swap> {
    const swapId = (input.swapId ?? "").trim();
    const orderId = (input.orderId ?? "").trim();
    const transactionReference = (input.transactionReference ?? "").trim();
    const amountPaidMinor = Number(input.amountPaidMinor);
    const expectedAmountMinor = input.expectedAmountMinor ?? null;
    const reportedCurrency = (input.currency ?? "").trim() || null;
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

    // --- Idempotency fast-path (optimization only; the DB UNIQUE is the guard)
    try {
      const existingTx =
        await this.transactionRepository.findByReference(transactionReference);
      if (existingTx) {
        const existingSwap = await this.swapRepository.findById(swapId);
        if (existingSwap) {
          this.logger.info(
            "Duplicate swap finalization detected; returning existing swap",
            { swapId, orderId, transactionReference, existingTxId: existingTx.id },
          );
          await this.auditIdempotent(actorId, swapId, orderId, transactionReference);
          return existingSwap;
        }
        throw new DomainError(
          "DUPLICATE_TRANSACTION",
          "This swap payment event has already been processed.",
        );
      }
    } catch (err: unknown) {
      if (err instanceof DomainError) {
        throw err;
      }
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to check existing swap transaction for idempotency",
        { err, transactionReference, swapId },
      );
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while checking swap idempotency.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while checking swap idempotency.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to verify swap idempotency.",
      );
    }

    // --- Resolve the DURABLE obligation + swap + order (authoritative) --------
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
        "Failed to resolve payment obligation during swap finalization",
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

    if (!payment || payment.obligationType !== "swap") {
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Swap finalization requires a resolvable swap payment obligation.",
      );
    }

    const swap = await this.loadSwap(payment.obligationId, transactionReference);
    if (swap.id.trim() !== swapId || swap.orderId.trim() !== orderId) {
      this.logger.warn("Swap identity does not match the claimed event context", {
        swapId,
        orderId,
        obligationSwapId: swap.id,
        obligationOrderId: swap.orderId,
        transactionReference,
      });
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Swap identity does not match the event context.",
      );
    }

    // --- Defensive financial re-checks (verification already ran upstream) ----
    if (amountPaidMinor !== payment.amountMinor) {
      this.logger.warn(
        "Captured amount does not match the swap payment obligation",
        { swapId, transactionReference, amountPaidMinor, obligationAmountMinor: payment.amountMinor },
      );
      throw new DomainError(
        "INVALID_PAYMENT_AMOUNT",
        "Captured amount does not match the swap payment obligation.",
      );
    }
    if (expectedAmountMinor !== null && expectedAmountMinor !== payment.amountMinor) {
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Swap payment event expectation is stale versus the durable obligation.",
      );
    }
    if (
      payment.currency &&
      reportedCurrency &&
      payment.currency.toLowerCase() !== reportedCurrency.toLowerCase()
    ) {
      throw new DomainError(
        "INVALID_CURRENCY",
        "Paid currency does not match the swap payment obligation currency.",
      );
    }

    let order: Order | null;
    try {
      order = await this.orderRepository.findById(swap.orderId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load order during swap finalization", {
        err,
        swapId,
        orderId: swap.orderId,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while loading order.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while loading order.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to load order.");
    }
    if (!order) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "Order for the swap was not found.",
      );
    }

    const returnedLine = order.lineItems.find(
      (li) => li.id === swap.returnLineItemId,
    );
    if (!returnedLine) {
      throw new DomainError(
        "INVALID_RETURN_ITEM",
        "Return line item not found on order.",
      );
    }

    // --- Atomic finalization ---------------------------------------------------
    // swap state transition + order modification + replacement-item inventory +
    // payment capture + ledger record + audit event, all in ONE unit of work.
    const nowIso = new Date().toISOString();
    let activeSwap: Swap;
    try {
      activeSwap = await this.transactionManager.execute(async () => {
        // 1. Swap state transition (awaiting_payment/pending -> completed).
        //    swap.complete() throws INVALID_STATUS_TRANSITION for a canceled or
        //    already-completed swap — the atomic guard.
        swap.complete();

        // 2. Order modification: remove returned quantity, add replacement line,
        //    adjust total ONLY by the swap variance (frozen financial structure).
        order.applySwap({
          returnLineItemId: swap.returnLineItemId,
          returnQuantity: swap.returnQuantity,
          newVariantId: swap.newVariantId,
          unitPriceMinor: swap.newVariantPriceMinor,
          appliedBy: actorId,
          appliedAt: nowIso,
        });
        await this.orderRepository.save(order);

        // 3. Confirm the swap's replacement hold (L9). The replacement variant
        //    was reserved ATOMICALLY at swap creation (swap-scoped key anchored
        //    on the deterministic swap id). Confirmation consumes the held
        //    units atomically with the swap completion; replaying a finalized
        //    swap finds the rows already terminal and is a NO-OP, so units are
        //    never consumed twice. The RETURNED variant is intentionally NOT
        //    auto-restocked here: it is physically coming back and only becomes
        //    sellable after receipt inspection (a separate returns flow).
        await this.confirmInventoryReservation.execute({
          orderId: swap.id,
          scope: "swap",
          actorId,
        });

        // 4. Payment capture (idempotent for an already-captured obligation).
        payment.markCaptured();
        await this.paymentRepository.save(payment);

        // 5. Ledger record: the upcharge movement. `reference` is UNIQUE and IS
        //    the authoritative idempotency anchor — a duplicate/retry/concurrent
        //    delivery collides here and rolls back the whole unit of work.
        await this.transactionRepository.save(
          new Transaction({
            id: this.idGenerator.generate(),
            orderId: order.id,
            amountMinor: swap.differenceMinor,
            reference: transactionReference,
            createdAt: nowIso,
          }),
        );

        // 6. Persist the completed swap.
        await this.swapRepository.save(swap);

        return swap;
      });
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;

      // --- Unique-conflict race (handled intentionally) --------------------------
      // A concurrent worker finalized the SAME swap payment reference between our
      // fast-path check and our insert. The losing unit of work rolled back
      // (leaving NO partial swap). Resolve idempotently to the committed swap.
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        this.logger.info(
          "Unique conflict on swap payment reference during finalization; resolving idempotently",
          { transactionReference, swapId, orderId },
        );
        const resolved = await this.swapRepository.findById(swapId);
        if (resolved) {
          return resolved;
        }
        throw new DomainError(
          "DUPLICATE_TRANSACTION",
          "This swap payment event has already been processed.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while finalizing swap.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while finalizing swap.",
        );
      }

      if (err instanceof DomainError) {
        throw err;
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to finalize swap transaction.",
      );
    }

    // --- Audit log (non-blocking, AFTER the transaction resolves) --------------
    // The audit is a secondary, non-blocking side effect: a failure here never
    // rolls back the committed swap, matching the checkout finalization flow.
    try {
      await this.auditLogService.logAction(actorId, "SWAP_FINALIZED", {
        auditId: this.idGenerator.generate(),
        swapId: activeSwap.id,
        orderId: order.id,
        transactionReference,
        returnLineItemId: swap.returnLineItemId,
        returnQuantity: String(swap.returnQuantity),
        newVariantId: swap.newVariantId,
        differenceMinor: String(swap.differenceMinor),
        paymentId: payment.id,
        finalizedAt: nowIso,
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for swap finalization", {
        err: auditErr,
        swapId: activeSwap.id,
        orderId: order.id,
      });
    }

    this.logger.info("Swap finalized successfully", {
      swapId: activeSwap.id,
      orderId: order.id,
      transactionReference,
      differenceMinor: swap.differenceMinor,
    });
    return activeSwap;
  }

  /** Resolve the swap for a swap payment obligation, mapping persistence errors. */
  private async loadSwap(
    obligationSwapId: string,
    transactionReference: string,
  ): Promise<Swap> {
    let swap: Swap | null;
    try {
      swap = await this.swapRepository.findById(obligationSwapId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load swap during finalization", {
        err,
        swapId: obligationSwapId,
        transactionReference,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while loading swap.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while loading swap.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to load swap.");
    }
    if (!swap) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "Swap for the payment obligation was not found.",
      );
    }
    return swap;
  }

  /** Non-blocking audit for an idempotent replay. */
  private async auditIdempotent(
    actorId: string,
    swapId: string,
    orderId: string,
    transactionReference: string,
  ): Promise<void> {
    try {
      await this.auditLogService.logAction(
        actorId,
        "SWAP_FINALIZATION_IDEMPOTENT",
        {
          auditId: this.idGenerator.generate(),
          swapId,
          orderId,
          transactionReference,
          notedAt: new Date().toISOString(),
        },
      );
    } catch {
      /* swallow audit errors */
    }
  }
}