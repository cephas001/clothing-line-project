// apps/api/src/use-cases/checkout/ResetFailedPaymentInitializationUseCase.ts

// Use case: release the shipping/payment mutation lock after a genuinely
// failed or abandoned payment attempt.
//
// A customer whose gateway initialization failed or whose payment page was
// abandoned cannot change shipping, because the durable checkout obligation
// freezes the authoritative amount + shipping snapshot (the L3 payment-failure
// gap). This use case lets a legitimate retry proceed:
//
//   - resolves the cart and confirms actor/ownership (final authorization);
//   - confirms the obligation is RESETTABLE: `initialization_pending` (gateway
//     never accepted), `initialized` (accepted but abandoned), or already
//     `failed`. A SETTLED obligation (captured/refunded/partially_refunded)
//     is REFUSED — money already handled is never touched;
//   - transitions the obligation to `failed`, PRESERVING the Payment row and
//     its history (reference, provider reference, provider URL, amount,
//     breakdown, metadata are all retained — nothing is deleted or cleared);
//   - clears ONLY the cart's payment-initialization mirror, which is the
//     in-memory/row copy that otherwise blocks re-selection;
//   - persists both in ONE transaction so the released lock is durable.
//
// After a reset the customer may re-select shipping (selection is allowed once
// the only existing obligation is `failed`), then re-initialize: the next
// initialization derives a deterministic PER-ATTEMPT reference from the count
// of failed obligations, so it creates a fresh obligation row and a fresh
// gateway transaction (never re-using a reference that already produced a
// possibly different-amount transaction).
//
// Idempotency: resetting an obligation that is already `failed`, or calling
// reset on a cart with no obligation, is a harmless no-op (resettled=false).
//
// Error contract:
//   400 VALIDATION_ERROR   — missing cartId
//   403 PERMISSION_DENIED  — foreign cart
//   404 CART_NOT_FOUND
//   409 INVALID_OPERATION  — frozen / paid / converted cart, OR a SETTLED
//                            obligation (captured/refunded/partially_refunded)
//   500 INTERNAL_ERROR     — persistence/infrastructure failures

import { DomainError } from "#domain/entities/errors/DomainError";
import { Payment, PaymentState } from "@api/domain/entities/Payment";
import { Cart } from "@api/domain/entities/Cart";
import { ReleaseInventoryReservationUseCase } from "@api/use-cases/inventory/ReleaseInventoryReservationUseCase";
import { ICartRepository } from "#domain/interfaces/repositories/ICartRepository";
import { IPaymentRepository } from "#domain/interfaces/repositories/IPaymentRepository";
import { IAuditLogService } from "#domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "#domain/interfaces/shared/IIdGenerator";
import { ILogger } from "#domain/interfaces/shared/ILogger";
import { ITransactionManager } from "#domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "#domain/interfaces/shared/errors/RepositoryError";

export interface ResetFailedPaymentInitializationInput {
  cartId: string;
  actorId?: string;
}

export interface ResetFailedPaymentInitializationResult {
  /** False when there was no obligation to reset (already reset or none). */
  resettled: boolean;
  paymentId?: string;
  priorStatus?: PaymentState;
  paymentReference?: string;
}

export class ResetFailedPaymentInitializationUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly paymentRepository: IPaymentRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
    private readonly releaseInventoryReservation: ReleaseInventoryReservationUseCase,
  ) {}

  async execute(
    input: ResetFailedPaymentInitializationInput,
  ): Promise<ResetFailedPaymentInitializationResult> {
    const cartId = (input.cartId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }

    // --- Load cart
    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart for payment-obligation reset", {
        err,
        cartId,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while fetching cart.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while fetching cart.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch cart.");
    }

    if (!cart) {
      throw new DomainError("CART_NOT_FOUND", "Cart session not found.");
    }

    // --- Cart ownership enforcement (final authorization boundary)
    // The authenticated identity originates EXCLUSIVELY from the verified JWT
    // (never the request body — the router resolves it and the use case is the
    // final authority). A foreign cart can never have its obligation reset.
    const authenticatedCustomerId = (input.actorId ?? "").trim();
    if (
      authenticatedCustomerId &&
      cart.customerId &&
      cart.customerId !== authenticatedCustomerId
    ) {
      throw new DomainError(
        "PERMISSION_DENIED",
        "Cart does not belong to the authenticated customer.",
      );
    }

    // --- The obligation must be resettable, and the cart must still be live --
    // A frozen cart (B2B quote), a paid cart, or a converted cart cannot have
    // its payment obligation reset — that would invalidate money already
    // handled or an order already produced.
    if (cart.frozen) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot reset payment for a frozen cart.",
      );
    }
    if (cart.paymentStatus === "paid") {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot reset payment for a paid cart.",
      );
    }
    if (cart.isConverted()) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot reset payment for a cart that has already been converted to an order.",
      );
    }

    // --- Resolve the current checkout obligation (most recent row) ------------
    let existing: Payment | null;
    try {
      existing = await this.paymentRepository.findByObligation("checkout", cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to resolve payment obligation for reset",
        { err, cartId },
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

    // No obligation -> nothing locks the cart. Idempotent no-op.
    if (!existing) {
      this.logger.info("No checkout obligation to reset", { cartId });
      return { resettled: false };
    }

    // A settled obligation is NEVER resettable: captured/refunded/
    // partially_refunded money must not be re-opened.
    if (!existing.isResettable()) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot reset a settled payment obligation.",
      );
    }

    const priorStatus = existing.status;
    const paymentReference = existing.reference;
    const paymentId = existing.id;

    // --- Transition + persist in ONE unit of work -----------------------------
    // The obligation is marked `failed` (history preserved — the row, its
    // reference, provider reference/URL, amount, breakdown and metadata stay
    // untouched). The cart's payment-initialization MIRROR is cleared so a
    // re-selection is no longer blocked by the cart flag; the durable Payment
    // history is not deleted.
    existing.markFailed();
    if (cart.isPaymentInitialized()) {
      cart.clearPaymentInitialization();
    }

    try {
      await this.transactionManager.execute(async () => {
        // Release the checkout reservation held against the obligation's
        // DETERMINISTIC reference back to the available pool (L9 Part 3),
        // INSIDE this unit of work so the release commits/rolls back with the
        // reset — a failed reset never strands the hold. Idempotent: held
        // units release once; already-terminal rows are a no-op. Custom-only
        // carts with no reservations are untouched.
        await this.releaseInventoryReservation.execute({
          orderId: existing.reference,
          reason: "payment_failed",
          actorId,
        });
        await this.paymentRepository.save(existing);
        await this.cartRepository.save(cart);
      });
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist payment-obligation reset", {
        err,
        cartId,
        paymentId,
        paymentReference,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while persisting payment reset.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while persisting payment reset.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.LOCKED) {
        throw new DomainError(
          "LOCK_ACQUISITION_FAILED",
          "Cart was concurrently modified; retry the request.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist payment reset.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId,
        "CHECKOUT_PAYMENT_OBLIGATION_RESET",
        {
          auditId: this.idGenerator.generate(),
          cartId,
          paymentId,
          paymentReference,
          priorStatus,
          resettledAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for payment-obligation reset", {
        err: auditErr,
        cartId,
        paymentId,
      });
    }

    this.logger.info("Checkout payment obligation reset", {
      cartId,
      paymentId,
      paymentReference,
      priorStatus,
    });

    return {
      resettled: true,
      paymentId,
      priorStatus,
      paymentReference,
    };
  }
}