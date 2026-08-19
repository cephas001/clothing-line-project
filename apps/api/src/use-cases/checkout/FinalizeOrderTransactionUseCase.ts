// apps/api/src/use-cases/checkout/FinalizeOrderTransactionUseCase.ts
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { ITransactionRepository } from "@api/domain/interfaces/repositories/ITransactionRepository";
import { IPaymentRepository } from "@api/domain/interfaces/repositories/IPaymentRepository";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { Order, OrderLineItem } from "@api/domain/entities/Order";
import { Cart } from "@api/domain/entities/Cart";
import { Payment } from "@api/domain/entities/Payment";
import { InventoryLocation } from "@api/domain/entities/InventoryLocation";
import { ConfirmInventoryReservationUseCase } from "@api/use-cases/inventory/ConfirmInventoryReservationUseCase";
import { PromotionSnapshot, OrderShippingSnapshot, OrderSourcingSnapshot } from "@api/domain/shared/contracts";
import {
  buildOrderShippingSnapshot,
  toOrderShippingSnapshot,
} from "@api/domain/shared/shippingSnapshot";
import { buildOrderSourcingSnapshot } from "@api/domain/shared/sourcingSnapshot";
import { IInventoryReservationRepository } from "@api/domain/interfaces/repositories/IInventoryReservationRepository";
import { IInventoryLocationRepository } from "@api/domain/interfaces/repositories/IInventoryLocationRepository";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { INotificationOutboxRepository } from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import { NotificationIntent } from "@api/domain/shared/notifications";

/**
 * Use case: finalize an order after a successful payment event.
 *
 * Responsibilities:
 * - Enforce strict idempotency for payment events. `transaction.reference` is
 *   UNIQUE at the database and is used as the idempotency key; concurrent
 *   finalizations for the same reference must resolve to the SAME order.
 * - Populate `order.transactionReference` so the order row itself participates
 *   in the idempotency guarantee (`order.transaction_reference` is UNIQUE).
 * - Validate cart and payment amounts against the DURABLE payment obligation
 *   (the frozen source of financial truth). A payment reference that resolves
 *   to no obligation fails CLOSED — the captured amount is never validated
 *   against the current cart total.
 * - Create Order and Transaction records inside a single transactional unit of work.
 * - Mark the cart as converted/checked out and persist state.
 * - Handle the unique-conflict race INTENTIONALLY: the check-then-create pattern
 *   cannot be atomic, so a concurrent winner commits between our idempotency
 *   check and our insert. The loser's insert collides on the UNIQUE
 *   constraints and surfaces as RepositoryErrorCode.DUPLICATE — which is
 *   resolved idempotently to the already-committed order instead of surfacing
 *   as an INTERNAL_ERROR (a duplicate webhook must never become one).
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the finalization.
 * - Return the persisted Order domain entity.
 *
 * L8 PART 5 + PART 6 — payment confirmation / order-confirmed notification:
 * The canonical "order confirmed" transition is THIS use case: the order row is
 * created with paymentStatus "captured" and the durable payment obligation is
 * marked captured in the same unit of work — the single authoritative source of
 * the confirmation (no other use case creates a captured order). A
 * `payment_confirmation` notification intent is appended to the durable outbox
 * INSIDE that same transaction, so the notification can only ever be relayed
 * AFTER the captured/finalized state commits, and a crash after commit but
 * before queue enqueue cannot lose it (the outbox sweep relays later). The
 * deterministic event key is `order-confirmed:<orderId>` — mapped by
 * buildNotificationJobId to the stable queue jobId
 * `notification:payment_confirmation:<orderId>` — so duplicate webhooks and
 * finalization replays resolve idempotently to the committed order and never
 * append (or enqueue) a second confirmation.
 */
export interface FinalizeOrderTransactionInput {
  cartId: string;
  transactionReference: string;
  amountPaidMinor: number;
  /**
   * ISO-4217 currency (lowercase) reported for the charge. Verified against the
   * DURABLE payment obligation when one resolves.
   */
  currency?: string | null;
  /**
   * The authoritative expected amount (the durable obligation's amountMinor).
   * When present, the captured amount must equal it exactly.
   */
  expectedAmountMinor?: number | null;
  actorId?: string;
}

export class FinalizeOrderTransactionUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly transactionRepository: ITransactionRepository,
    private readonly paymentRepository: IPaymentRepository,
    private readonly cartRepository: ICartRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
    private readonly notificationOutboxRepository: INotificationOutboxRepository,
    private readonly confirmInventoryReservation: ConfirmInventoryReservationUseCase,
    private readonly inventoryReservationRepository: IInventoryReservationRepository,
    private readonly inventoryLocationRepository: IInventoryLocationRepository,
  ) {}

  async execute(input: FinalizeOrderTransactionInput): Promise<Order> {
    const cartId = (input.cartId ?? "").trim();
    const transactionReference = (input.transactionReference ?? "").trim();
    const amountPaidMinor = Number(input.amountPaidMinor);
    const expectedAmountMinor = input.expectedAmountMinor ?? null;
    const reportedCurrency = (input.currency ?? "").trim() || null;
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
    if (!Number.isSafeInteger(amountPaidMinor) || amountPaidMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "amountPaidMinor must be a non-negative integer in minor units.",
      );
    }

    // --- Idempotency: if transaction already processed, return associated order.
    // This is an optimization fast-path only; the real guard is the database
    // UNIQUE constraints (order.transaction_reference, transaction.reference),
    // and the unique-conflict race is handled intentionally below.
    try {
      const existing = await this.resolveExistingOrder(
        transactionReference,
        actorId,
      );
      if (existing) {
        return existing;
      }
    } catch (err: any) {
      // A DomainError (e.g. DUPLICATE_TRANSACTION when the transaction exists
      // but its order is missing) must propagate untouched — a duplicate webhook
      // must never be masked as INTERNAL_ERROR.
      if (err instanceof DomainError) {
        throw err;
      }
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

    // --- Validate paid amount against the authoritative source ---------------
    // The DURABLE payment obligation is the source of financial truth: its
    // `amountMinor` is exactly what the gateway was asked to capture and what
    // the webhook must match — never a live re-computation of the cart total,
    // which can drift if the cart mutates after initialization. The obligation
    // also carries the authoritative currency; a provider-reported currency
    // that disagrees with it is rejected.
    let payment: Payment | null = null;
    try {
      payment =
        (await this.paymentRepository.findByReference(transactionReference)) ??
        (await this.paymentRepository.findByProviderReference(
          transactionReference,
        ));
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to resolve payment obligation during order finalization",
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

    // Defense in depth: the queued event declares the expected amount (the
    // mapper sets it to the durable obligation's amountMinor). A mismatch here
    // is a permanent, non-retryable failure.
    if (expectedAmountMinor !== null && amountPaidMinor !== expectedAmountMinor) {
      this.logger.warn("Paid amount does not match the expected obligation amount", {
        cartId,
        transactionReference,
        amountPaidMinor,
        expectedAmountMinor,
      });
      throw new DomainError(
        "INVALID_PAYMENT_AMOUNT",
        "Paid amount does not match the expected obligation amount.",
      );
    }

    if (!payment) {
      // Every payable webhook MUST resolve to a durable payment obligation.
      // The verification gate (VerifyPaymentEventUseCase) enforces this before
      // this use case runs; as defense-in-depth, finalization NEVER reconstructs
      // what the customer was charged from the CURRENT cart (prices/cart may
      // have drifted since initialization). An absent obligation is a permanent
      // failure — no order is created.
      this.logger.warn(
        "No durable payment obligation for finalization; refusing to finalize",
        { cartId, transactionReference },
      );
      throw new DomainError(
        "PAYMENT_VERIFICATION_FAILED",
        "Payment reference does not resolve to a durable payment obligation.",
      );
    }

    if (payment.amountMinor !== amountPaidMinor) {
      this.logger.warn("Paid amount does not match the durable payment obligation", {
        cartId,
        transactionReference,
        amountPaidMinor,
        obligationAmountMinor: payment.amountMinor,
      });
      throw new DomainError(
        "INVALID_PAYMENT_AMOUNT",
        "Paid amount does not match the payment obligation amount.",
      );
    }
    if (
      payment.currency &&
      reportedCurrency &&
      payment.currency.toLowerCase() !== reportedCurrency.toLowerCase()
    ) {
      this.logger.warn("Paid currency does not match the payment obligation currency", {
        cartId,
        transactionReference,
        reportedCurrency,
        obligationCurrency: payment.currency,
      });
      throw new DomainError(
        "INVALID_CURRENCY",
        "Paid currency does not match the payment obligation currency.",
      );
    }

    // --- Create order and transaction inside a transaction/unit-of-work
    const orderId = this.idGenerator.generate();
    const transactionId = this.idGenerator.generate();
    const nowIso = new Date().toISOString();

    // Frozen financial snapshot of any promotion applied to the cart. The
    // applied discount comes from the DURABLE payment obligation (frozen at
    // initialization) — never recomputed from the current cart/promotion
    // config, so later catalog/price changes cannot alter what the order
    // records (historical integrity).
    const promotion = cart.appliedPromotion;
    let promotionSnapshot: PromotionSnapshot | null = null;
    if (promotion) {
      promotionSnapshot = {
        promotionId: promotion.id,
        code: promotion.code,
        discountType: promotion.discountType,
        discountValueMinor: promotion.discountValueMinor,
        minimumSpendMinor: promotion.minimumSpendMinor,
        appliedDiscountMinor: payment.discountMinor,
      };
    }

    // The order's line items MUST mirror exactly what was charged at
    // initialization. The charged snapshot is frozen on the durable payment
    // obligation; a cart that mutated after initialization must not change what
    // the order records.
    const chargedLineItems = snapshotLineItems(payment, cart);

    // The order's shipping snapshot MUST be the EXACT shipping the checkout
    // total was built from: the request token, selected courier/service,
    // destination, and parcel items frozen on the durable payment obligation at
    // initialization (mirroring the line-item freeze). An order never
    // reconstructs shipping from today's rates or a mutated cart. Obligations
    // created before shipping was frozen degrade to the cart's durable
    // selection with a warning (historical integrity is preserved by the frozen
    // financial values, which are already verified against the obligation).
    const frozenShippingSnapshot = toOrderShippingSnapshot(
      payment?.metadata?.shippingSnapshot,
    );
    const shippingSnapshot =
      frozenShippingSnapshot ?? buildOrderShippingSnapshot(cart);
    if (!frozenShippingSnapshot && cart.hasShippingSelection) {
      this.logger.warn(
        "Shipping snapshot not frozen on payment obligation; using cart selection",
        { cartId, transactionReference },
      );
    }

    const createWork = async () => {
      // --- Confirm the checkout reservation + freeze the sourcing snapshot ---
      // The reservation ledger was anchored on the DETERMINISTIC payment
      // reference at initialization (equal to transactionReference in the
      // standard flow; `payment.reference` when a provider-reference webhook
      // resolved the obligation). Confirming runs INSIDE this unit of work so
      // the consumed units commit atomically with the order: a failed
      // finalization rolls the confirmation back (units stay held for the
      // retry) and a duplicate/replayed finalization is a no-op (the rows are
      // already terminal). The frozen OrderSourcingSnapshot then records
      // EXACTLY which locations' units became this order.
      const sourcingAnchor = payment?.reference ?? transactionReference;
      await this.confirmInventoryReservation.execute({
        orderId: sourcingAnchor,
        actorId,
      });
      let sourcingSnapshot: OrderSourcingSnapshot | null = null;
      const sourcingReservations =
        await this.inventoryReservationRepository.findByOrder(sourcingAnchor);
      if (sourcingReservations.length > 0) {
        const locationIds = [
          ...new Set(sourcingReservations.map((r) => r.locationId)),
        ];
        const locations: InventoryLocation[] = [];
        for (const locationId of locationIds) {
          const location =
            await this.inventoryLocationRepository.findById(locationId);
          if (location) {
            locations.push(location);
          }
        }
        sourcingSnapshot = buildOrderSourcingSnapshot(
          sourcingReservations,
          locations,
          nowIso,
        );
      }

      // Instantiate Order domain entity. `transactionReference` is populated so
      // the order row carries the payment idempotency key; combined with the
      // UNIQUE order.transaction_reference constraint, the loser of a concurrent
      // race collides here (before the transaction insert) instead of creating a
      // second order. The financial snapshot (currency, subtotal, discount, tax,
      // shipping, insurance) is frozen from the durable payment obligation so
      // the order never depends on today's prices or config.
      const order = new Order({
        id: orderId,
        cartId: cart.id,
        customerId: orderCustomerId,
        totalAmountMinor: amountPaidMinor,
        currency: payment?.currency ?? reportedCurrency,
        subtotalMinor: payment?.subtotalMinor,
        discountMinor: payment?.discountMinor,
        taxMinor: payment?.taxMinor,
        shippingMinor: payment?.shippingMinor,
        insuranceMinor: payment?.insuranceMinor,
        transactionReference,
        fulfillmentStatus: "unfulfilled",
        paymentStatus: "captured",
        createdAt: nowIso,
        lineItems: chargedLineItems,
        promotionSnapshot,
        shippingSnapshot,
        sourcingSnapshot,
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

      // Reconcile the durable payment intent: mark the corresponding payment
      // obligation captured so the payment record mirrors the settled
      // transaction. The obligation was resolved before the transaction and is
      // reused here (same unique idempotency keys). This runs inside the same
      // unit of work as the order.
      if (payment) {
        payment.markCaptured();
        await this.paymentRepository.save(payment);
      }

      // --- Order-confirmed notification intent (L8 PART 5/6, inside the tx) --
      // The "notification" is the DURABLE INTENT only — no provider is called
      // here and nothing is enqueued yet. Appending inside this transaction
      // commits the intent atomically with the captured/finalized state, which
      // is the recovery mechanism for a crash after commit but before the sweep
      // enqueues: the row is already committed and `EnqueuePendingNotifications
      // UseCase` relays it afterwards (the enqueue therefore always happens
      // AFTER the transaction commits). A duplicate webhook / finalization
      // replay returns earlier via resolveExistingOrder and never reaches this
      // append; a concurrent race that loses rolls the whole unit of work back.
      // The recipient is the AUTHORITATIVE checkout email frozen on the cart
      // (assigned at customer binding), never an HTTP/webhook body value. All
      // financial values come from the durable payment obligation breakdown and
      // the frozen charged line-item snapshot. If no cart email is present the
      // intent is skipped (best-effort) — the order still finalizes.
      const customerEmail = (cart.email ?? "").trim();
      if (payment && customerEmail) {
        const orderConfirmedIntent: NotificationIntent = {
          type: "payment_confirmation",
          payload: {
            recipient: { email: customerEmail },
            order: {
              orderId: order.id,
              cartId: cart.id,
              customerId: orderCustomerId,
              currency: payment.currency ?? reportedCurrency,
              createdAt: nowIso,
            },
            transactionReference,
            breakdown: payment.breakdown,
            // The durable capture/finalization timestamp — the moment the
            // captured state was durably recorded, never a live "now" at send.
            paidAt: nowIso,
            lineItems: chargedLineItems.map((line) => ({
              id: line.id,
              variantId: line.variantId ?? null,
              quantity: line.quantity,
              unitPriceMinor: line.unitPriceMinor,
            })),
          },
        };
        await this.notificationOutboxRepository.append(
          this.idGenerator.generate(),
          orderConfirmedIntent,
        );
      }

      return order;
    };

    let persistedOrder: Order;
    try {
      persistedOrder = await this.transactionManager.execute(createWork);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;

      // --- Unique-conflict race (handled intentionally) --------------------------
      // A concurrent worker finalized the SAME payment reference between our
      // idempotency fast-path check and our insert. The losing insert collided
      // on order.transaction_reference / transaction.reference (both UNIQUE) and
      // the whole unit of work rolled back. Resolve idempotently to the
      // already-committed order rather than surfacing INTERNAL_ERROR.
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        this.logger.info(
          "Unique conflict on payment reference during finalization; resolving idempotently",
          { transactionReference, cartId },
        );
        try {
          const existing = await this.resolveExistingOrder(
            transactionReference,
            actorId,
          );
          if (existing) {
            return existing;
          }
        } catch (resolutionErr: unknown) {
          const rErr = resolutionErr as RepositoryError | undefined;
          this.logger.error(
            "Failed to resolve order after unique conflict on payment reference",
            { err: resolutionErr, transactionReference },
          );
          if (rErr?.code === RepositoryErrorCode.CONNECTION) {
            throw new DomainError(
              "INTERNAL_ERROR",
              "Database connection error while resolving conflicting finalization.",
            );
          }
          if (rErr?.code === RepositoryErrorCode.TIMEOUT) {
            throw new DomainError(
              "INTERNAL_ERROR",
              "Database timeout while resolving conflicting finalization.",
            );
          }
        }

        // The reference exists but its order could not be resolved — a data
        // anomaly retrying cannot fix. Fail terminally (never double-process).
        throw new DomainError(
          "DUPLICATE_TRANSACTION",
          "This payment event has already been processed.",
        );
      }

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
      if (repoErr?.code === RepositoryErrorCode.LOCKED) {
        throw new DomainError(
          "LOCK_ACQUISITION_FAILED",
          "Cart was concurrently modified; retry the request.",
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

  /**
   * Resolve the order already associated with a transaction reference.
   *
   * Used both as the idempotency fast-path (before the write) and after a
   * unique-conflict race (a concurrent winner already committed the reference).
   * Returns `null` when no transaction exists yet; throws `DUPLICATE_TRANSACTION`
   * when a transaction exists but its order cannot be found — retrying cannot
   * repair that data anomaly, and double-processing must be prevented.
   */
  private async resolveExistingOrder(
    transactionReference: string,
    actorId: string,
  ): Promise<Order | null> {
    const existingTx =
      await this.transactionRepository.findByReference(transactionReference);
    if (!existingTx) {
      return null;
    }

    const existingOrder = await this.orderRepository.findById(existingTx.orderId);
    if (!existingOrder) {
      this.logger.warn(
        "Transaction exists without its order during idempotency handling",
        { transactionReference, existingTxId: existingTx.id },
      );
      throw new DomainError(
        "DUPLICATE_TRANSACTION",
        "This payment event has already been processed.",
      );
    }

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

    this.logger.info(
      "Duplicate transaction detected; returning existing order",
      { transactionReference, existingTxId: existingTx.id },
    );
    return existingOrder;
  }
}

/**
 * Resolve the line items the order must snapshot.
 *
 * Uses the CHARGED snapshot frozen on the durable payment obligation at
 * initialization (id, variantId, quantity, unitPriceMinor), so an order always
 * records exactly what was agreed at charge time even if the cart was mutated
 * afterwards. The obligation is guaranteed to resolve (the verification gate
 * runs before finalization), so a malformed snapshot is a defensive last resort
 * that degrades to the live cart — it never changes the charged amount, which
 * is already verified against the obligation's amountMinor.
 */
function snapshotLineItems(
  payment: Payment | null,
  cart: Cart,
): OrderLineItem[] {
  const snapshot = payment?.metadata?.lineItems;
  if (Array.isArray(snapshot) && snapshot.length > 0) {
    const lines: OrderLineItem[] = [];
    for (const raw of snapshot) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const it = raw as {
        id?: unknown;
        variantId?: unknown;
        quantity?: unknown;
        unitPriceMinor?: unknown;
      };
      const id = typeof it.id === "string" ? it.id.trim() : "";
      const quantity = Number(it.quantity);
      const unitPriceMinor = Number(it.unitPriceMinor);
      if (
        !id ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        !Number.isSafeInteger(unitPriceMinor) ||
        unitPriceMinor < 0
      ) {
        continue;
      }
      lines.push({
        id,
        variantId: typeof it.variantId === "string" ? it.variantId : null,
        quantity,
        unitPriceMinor,
      });
    }

    if (lines.length > 0) {
      return lines;
    }
  }

  return cart.items.map((item) => ({
    id: item.id,
    variantId: item.variantId ?? null,
    quantity: item.quantity,
    unitPriceMinor: item.unitPriceMinor,
  }));
}
