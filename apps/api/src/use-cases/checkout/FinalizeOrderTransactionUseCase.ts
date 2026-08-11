// apps/api/src/use-cases/checkout/FinalizeOrderTransactionUseCase.ts
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { ITransactionRepository } from "@api/domain/interfaces/repositories/ITransactionRepository";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { Order } from "@api/domain/entities/Order";
import { Cart } from "@api/domain/entities/Cart";
import { PromotionSnapshot } from "@api/domain/shared/contracts";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";

/**
 * Use case: finalize an order after a successful payment event.
 *
 * Responsibilities:
 * - Enforce strict idempotency for payment events.
 * - Validate cart and payment amounts.
 * - Create Order and Transaction records inside a single transactional unit of work.
 * - Mark the cart as converted/checked out and persist state.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the finalization.
 * - Return the persisted Order domain entity.
 */
export interface FinalizeOrderTransactionInput {
  cartId: string;
  transactionReference: string;
  amountPaidMinor: number;
  actorId?: string;
}

export class FinalizeOrderTransactionUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly transactionRepository: ITransactionRepository,
    private readonly cartRepository: ICartRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: FinalizeOrderTransactionInput): Promise<Order> {
    const cartId = (input.cartId ?? "").trim();
    const transactionReference = (input.transactionReference ?? "").trim();
    const amountPaidMinor = Number(input.amountPaidMinor);
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Basic validation
    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!transactionReference) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "transactionReference is required.",
      );
    }

    // --- Idempotency: if transaction already processed, return associated order
    try {
      const existingTx =
        await this.transactionRepository.findByReference(transactionReference);
      if (existingTx) {
        this.logger.info(
          "Duplicate transaction detected; returning existing order",
          { transactionReference, existingTxId: existingTx.id },
        );
        // Try to fetch the order associated with the existing transaction
        try {
          const existingOrder = await this.orderRepository.findById(
            existingTx.orderId,
          );
          if (existingOrder) {
            // Audit idempotent access (non-blocking)
            try {
              await this.auditLogService.logAction(
                actorId,
                "ORDER_FINALIZATION_IDEMPOTENT",
                {
                  auditId: this.idGenerator.generate(),
                  transactionReference,
                  orderId: existingOrder.id,
                  notedAt: new Date().toISOString(),
                },
              );
            } catch {
              /* swallow audit errors */
            }
            return existingOrder;
          }
        } catch (err: any) {
          this.logger.warn(
            "Failed to fetch order for existing transaction during idempotency handling",
            { err, transactionReference, existingTx },
          );
          // Fall through to rethrow duplicate transaction to avoid creating a second order if order missing
        }

        // If we couldn't return the order, treat as duplicate to avoid double-processing
        throw new DomainError(
          "DUPLICATE_TRANSACTION",
          "This payment event has already been processed.",
        );
      }
    } catch (err: any) {
      // If repository threw an error while checking idempotency, map conservatively
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to check existing transaction for idempotency",
        { err, transactionReference },
      );
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while checking transaction idempotency.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while checking transaction idempotency.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to verify transaction idempotency.",
      );
    }

    // --- Load cart and validate
    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart during order finalization", {
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

    if (!cart.customerId) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot finalize an order for a guest cart without a customer.",
      );
    }
    const orderCustomerId = cart.customerId;

    // Defensive: ensure cart hasn't already been converted to an order
    if (cart.isConverted()) {
      this.logger.info(
        "Cart already converted to order; aborting duplicate finalization",
        { cartId },
      );
      throw new DomainError(
        "INVALID_OPERATION",
        "Cart has already been converted to an order.",
      );
    }
    if (cart.orderId) {
      this.logger.info(
        "Cart already associated with an order; aborting duplicate finalization",
        { cartId, orderId: cart.orderId },
      );
      throw new DomainError(
        "INVALID_OPERATION",
        "Cart has already been converted to an order.",
      );
    }

    // Validate paid amount matches cart total (business rule; allow small tolerance if needed)
    const cartTotalMinor = Number(cart.cartTotalMinor);
    if (!Number.isFinite(cartTotalMinor) || cartTotalMinor < 0) {
      this.logger.error("Invalid cart total during order finalization", {
        cartId,
        cartTotalMinor,
      });
      throw new DomainError(
        "INVALID_STATE",
        "Cart total is invalid or missing.",
      );
    }

    if (amountPaidMinor !== cartTotalMinor) {
      this.logger.warn("Paid amount does not match cart total", {
        cartId,
        cartTotalMinor,
        amountPaidMinor,
      });
      // Business decision: treat mismatch as invalid payment unless system allows partial captures
      throw new DomainError(
        "INVALID_PAYMENT_AMOUNT",
        "Paid amount does not match cart total.",
      );
    }

    // --- Create order and transaction inside a transaction/unit-of-work
    const orderId = this.idGenerator.generate();
    const transactionId = this.idGenerator.generate();
    const nowIso = new Date().toISOString();

    // Frozen financial snapshot of any promotion applied to the cart.
    const promotion = cart.appliedPromotion;
    let promotionSnapshot: PromotionSnapshot | null = null;
    if (promotion) {
      promotionSnapshot = {
        promotionId: promotion.id,
        code: promotion.code,
        discountType: promotion.discountType,
        discountValueMinor: promotion.discountValueMinor,
        minimumSpendMinor: promotion.minimumSpendMinor,
        appliedDiscountMinor: promotion.computeDiscountAmount(cartTotalMinor),
      };
    }

    const createWork = async () => {
      // Instantiate Order domain entity
      const order = new Order({
        id: orderId,
        cartId: cart.id,
        customerId: orderCustomerId,
        totalAmountMinor: amountPaidMinor,
        fulfillmentStatus: "unfulfilled",
        paymentStatus: "captured",
        createdAt: nowIso,
        lineItems: cart.items.map((item) => ({
          id: item.id,
          variantId: item.variantId ?? null,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
        })),
        promotionSnapshot,
      });
      if (promotionSnapshot) {
        order.recordPromotionSnapshot(promotionSnapshot);
      }

      // Persist order
      await this.orderRepository.save(order);

      // Persist transaction record
      await this.transactionRepository.save({
        id: transactionId,
        orderId: order.id,
        reference: transactionReference,
        amountMinor: amountPaidMinor,
        createdAt: nowIso,
      });

      // Mark cart as converted/checked out using domain method if available
      cart.markConverted({ orderId: order.id, convertedAt: nowIso });

      // Persist cart state
      await this.cartRepository.save(cart);

      return order;
    };

    let persistedOrder: Order;
    try {
      persistedOrder = await this.transactionManager.execute(createWork);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while finalizing order.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while finalizing order.",
        );
      }

      // If the repository threw a DomainError, rethrow it
      if (err instanceof DomainError) {
        throw err;
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to finalize order transaction.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "ORDER_FINALIZED", {
        auditId: this.idGenerator.generate(),
        orderId: persistedOrder.id,
        cartId,
        transactionReference,
        amountMinor: String(amountPaidMinor),
        finalizedAt: nowIso,
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for order finalization", {
        err: auditErr,
        orderId: persistedOrder.id,
        cartId,
      });
    }

    this.logger.info("Order finalized successfully", {
      orderId: persistedOrder.id,
      cartId,
      transactionReference,
      amountMinor: amountPaidMinor,
    });
    return persistedOrder;
  }
}
