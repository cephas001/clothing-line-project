// apps/api/src/use-cases/logistics/ProcessOrderSwapVarianceUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Order } from "@api/domain/entities/Order";
import { Swap } from "@api/domain/entities/Swap";
import { Payment } from "@api/domain/entities/Payment";
import { Refund } from "@api/domain/entities/Refund";
import { Customer } from "@api/domain/entities/Customer";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { ISwapRepository } from "@api/domain/interfaces/repositories/ISwapRepository";
import { IPaymentRepository } from "@api/domain/interfaces/repositories/IPaymentRepository";
import { IRefundRepository } from "@api/domain/interfaces/repositories/IRefundRepository";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IPricingService } from "@api/domain/interfaces/services/IPricingService";
import { IPaymentService } from "@api/domain/interfaces/services/IPaymentService";
import { toPositiveQuantity } from "@api/utils/moneyUtils";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { INotificationOutboxRepository } from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import { NotificationIntent } from "@api/domain/shared/notifications";
import { ReserveInventoryUseCase } from "@api/use-cases/inventory/ReserveInventoryUseCase";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/** How long a swap replacement hold stays reserved while the swap is unresolved. */
const SWAP_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

// Internal control-flow markers for the cumulative refund guard. They never
// cross the use-case boundary: `claimSwapRefund` converts `...AlreadyClaimed`
// into a resolved replay, `dispatchSwapRefund` converts `...Unavailable` into
// a manual-review result, and an over-refund is surfaced as a DomainError.
class SwapRefundAlreadyClaimedError extends Error {
  constructor(
    readonly swap: Swap,
    readonly refund: Refund,
  ) {
    super("Swap refund already claimed; resolving existing record.");
    this.name = "SwapRefundAlreadyClaimedError";
  }
}

class RefundGuardUnavailableError extends Error {
  constructor(readonly swap: Swap) {
    super("Original captured payment cannot be resolved for the refund guard.");
    this.name = "RefundGuardUnavailableError";
  }
}

export interface ProcessOrderSwapVarianceInput {
  orderId: string;
  returnLineItemId: string;
  returnQuantity: number;
  newVariantId: string;
  actorId?: string;
  paymentRedirectBaseUrl?: string; // optional: where to redirect customer to complete payment
}

export interface ProcessOrderSwapVarianceResult {
  variance: number;
  action: "EVEN_EXCHANGE" | "PAYMENT_REQUIRED" | "REFUND_DISPATCHED";
  paymentUrl?: string | null;
  swapId: string;
}

export class ProcessOrderSwapVarianceUseCase {
  private static readonly MIN_QUANTITY = 1;

  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly cartRepository: ICartRepository,
    private readonly swapRepository: ISwapRepository,
    private readonly paymentRepository: IPaymentRepository,
    private readonly refundRepository: IRefundRepository,
    private readonly paymentService: IPaymentService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
    private readonly customerRepository: ICustomerRepository,
    private readonly pricingService: IPricingService,
    private readonly notificationOutboxRepository: INotificationOutboxRepository,
    private readonly reserveInventory: ReserveInventoryUseCase,
  ) {}

  /**
   * Calculate the monetary variance for a swap and take the appropriate action:
   * - If customer owes money, create a durable payment intent and return a payment URL.
   * - If brand owes money, issue an idempotent refund via the payment gateway.
   * - If even, persist the swap and return EVEN_EXCHANGE.
   *
   * Financial-integrity guarantees:
   * - The replacement price is NEVER client-supplied. It is resolved server-side
   *   through IPricingService (the single unit-price resolution seam) from the
   *   durable regional price (money_amount) for the order's originating region,
   *   so both sides of the variance are computed from frozen/authoritative
   *   state and the upcharge is stable across re-runs.
   * - The swap payment obligation is denominated in the order's FROZEN currency
   *   (order.currency, captured at checkout). An upcharge is never collected in
   *   a currency the server cannot prove for the order.
   * - Swap creation keys on the deterministic `swap.natural_key` (UNIQUE), so a
   *   re-run of the same swap request collides instead of creating a duplicate
   *   swap and a second gateway payment/refund. The payment reference derives
   *   from the RESOLVED swap id so it is stable across retries.
   * - Payment obligations are durable Payment rows claimed in the database
   *   BEFORE the gateway call; the gateway call is never assumed transactional
   *   with PostgreSQL.
   * - Refunds are durable Refund rows uniquely identified by
   *   (provider_transaction_reference, amount_minor). A refund stays 'pending'
   *   until the gateway confirms dispatch; an ambiguous outcome (timeout /
   *   network error) is NEVER auto-marked failed or blindly re-issued — a
   *   retry of the same request surfaces REFUND_REQUIRES_REVIEW so an operator
   *   reconciles against Paystack before any manual re-issue.
   * - Refunds are capped by a cumulative guard: each claim locks the original
   *   captured payment row (FOR UPDATE, transaction-scoped) and computes
   *   remaining = capturedAmount - sum(non-failed refunds) INSIDE that same
   *   transaction, rejecting an amount that exceeds the remaining balance.
   *   Concurrent refund claims serialize on the payment lock, so two requests
   *   can never both observe the same remaining balance and both dispatch. If
   *   the captured obligation cannot be resolved the refund is routed to
   *   manual review rather than issued unguarded.
   * - L8 PART 10 — refund notification: a `refund_issued` intent is appended to
   *   the durable outbox ONLY when the refund transitions to `dispatched`
   *   (gateway-confirmed completion), INSIDE the same transaction that persists
   *   that transition — never while the refund is merely claimed/`pending`
   *   (requested but not confirmed), and never on an idempotent replay of an
   *   already-dispatched refund. Amount/reference come from the persisted
   *   Refund row and the order's frozen currency — never recomputed. The
   *   deterministic discriminator is the refund's own `refundReference`.
   */
  async execute(
    input: ProcessOrderSwapVarianceInput,
  ): Promise<ProcessOrderSwapVarianceResult> {
    const orderId = (input.orderId ?? "").trim();
    const returnLineItemId = (input.returnLineItemId ?? "").trim();
    const returnQuantity = toPositiveQuantity(
      input.returnQuantity,
      "returnQuantity",
    );
    const newVariantId = (input.newVariantId ?? "").trim();
    // The authenticated identity (verified JWT) is kept separate from the
    // normalized actorId: an absent actorId means GUEST, and guest requests
    // remain allowed. Only a non-empty authenticated identity is enforced.
    const authenticatedCustomerId = (input.actorId ?? "").trim();
    const actorId = authenticatedCustomerId || "system";
    const paymentRedirectBaseUrl = input.paymentRedirectBaseUrl ?? null;

    // --- Validate inputs
    if (!orderId)
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    if (!returnLineItemId)
      throw new DomainError(
        "VALIDATION_ERROR",
        "returnLineItemId is required.",
      );
    if (!newVariantId)
      throw new DomainError("VALIDATION_ERROR", "newVariantId is required.");

    const auditId = this.idGenerator.generate();
    const startedAt = new Date().toISOString();
    this.logger.info("Processing swap variance", {
      orderId,
      returnLineItemId,
      returnQuantity,
      newVariantId,
      actorId,
      auditId,
    });

    // --- Load order
    let order: Order | null = null;
    try {
      order = await this.orderRepository.findById(orderId);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load order for swap variance", {
        err,
        orderId,
        auditId,
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
      this.logger.info("Order not found for swap variance", {
        orderId,
        auditId,
      });
      throw new DomainError("RESOURCE_NOT_FOUND", "Order not found.");
    }

    // --- Order ownership enforcement (final authorization boundary) ------------
    // A JWT-authenticated customer may ONLY process a swap (and thereby create a
    // swap payment obligation / refund) for an order that belongs to them. The
    // identity originates EXCLUSIVELY from the verified JWT — never the request
    // body. This check runs BEFORE any financial computation or side effect, so
    // a foreign order can never produce a payment obligation or refund.
    //   - authenticated + owned order (order.customerId === actor)      -> ALLOW
    //   - authenticated + foreign order (order.customerId !== actor)    -> REJECT
    //   - authenticated + unowned order (no order.customerId)           -> ALLOW
    //   - guest request (no actorId)                                    -> ALLOW
    if (
      authenticatedCustomerId &&
      order.customerId &&
      order.customerId !== authenticatedCustomerId
    ) {
      throw new DomainError(
        "PERMISSION_DENIED",
        "Order does not belong to the authenticated customer.",
      );
    }

    // Capture the narrowed aggregate for use inside the transaction closures.
    const loadedOrder = order;

    // --- Validate return line item exists and quantity is allowed
    const originalItem = loadedOrder.lineItems.find(
      (li) => String(li.id) === String(returnLineItemId),
    );
    if (!originalItem) {
      throw new DomainError(
        "INVALID_INPUT",
        "Return line item not found on order.",
      );
    }
    const fulfilledQty = Number(originalItem.fulfilledQuantity ?? 0);
    if (returnQuantity > fulfilledQty) {
      throw new DomainError(
        "INVALID_RETURN_QUANTITY",
        "Cannot return more items than were fulfilled.",
      );
    }

    // --- Compute original prorated value using the domain method
    let originalValueMinor: number;
    try {
      originalValueMinor = loadedOrder.calculateProratedValue(
        originalItem.id,
        returnQuantity,
      );
    } catch (err: any) {
      this.logger.error("Failed to compute original prorated value", {
        err,
        orderId,
        returnLineItemId,
        auditId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to compute original item value.",
      );
    }

    // --- Resolve the AUTHORITATIVE replacement price (server-side) -------------
    // The client NEVER supplies the replacement price. It is read from the
    // durable regional price (money_amount) for the order's originating region
    // (cart.region_id), so the variance is computed from server state only.
    let cart: Awaited<ReturnType<ICartRepository["findById"]>> | null = null;
    try {
      cart = await this.cartRepository.findById(loadedOrder.cartId);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load cart for swap variance", {
        err,
        orderId,
        cartId: loadedOrder.cartId,
        auditId,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while loading cart.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while loading cart.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to load cart.");
    }
    if (!cart || !cart.regionId) {
      this.logger.info("Cart region unavailable for swap variance", {
        orderId,
        cartId: loadedOrder.cartId,
        auditId,
      });
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot price the swap: the order cart has no originating region.",
      );
    }

    let replacementPriceMinor: number | null = null;
    try {
      replacementPriceMinor = await this.pricingService.getPriceForRegion(
        newVariantId,
        cart.regionId,
      );
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load regional price for swap variance", {
        err,
        orderId,
        newVariantId,
        regionId: cart.regionId,
        auditId,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while loading regional price.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while loading regional price.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to load regional price.");
    }
    if (replacementPriceMinor === null) {
      throw new DomainError(
        "REGIONAL_PRICE_MISSING",
        "No authoritative regional price exists for the replacement variant.",
      );
    }
    const newVariantPriceMinor = replacementPriceMinor;
    const newValueMinor = Math.floor(newVariantPriceMinor * returnQuantity);
    const differenceMinor = newValueMinor - originalValueMinor;

    // --- Freeze the swap currency from the order's frozen currency -------------
    // order.currency was captured from the region at checkout, so it is the
    // server-authoritative denomination for any money the customer owes. An
    // upcharge is never collected in a currency the server cannot prove.
    const orderCurrency = (loadedOrder.currency ?? "").trim() || null;
    if (differenceMinor > 0 && !orderCurrency) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot collect swap payment for an order without a frozen currency.",
      );
    }

    // --- Resolve the customer email when the customer owes money ---------------
    // Paystack requires a customer email on /transaction/initialize. The order
    // carries only customerId; the swap-payment flow resolves the email from the
    // customer record here (application layer), so the payment adapter never
    // needs to query repositories. Fail fast when the customer is missing or has
    // no usable email.
    let customerEmail: string | null = null;
    if (differenceMinor > 0) {
      if (!loadedOrder.customerId) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Cannot collect swap payment for an order without a customer.",
        );
      }
      let customer: Customer | null = null;
      try {
        customer = await this.customerRepository.findById(loadedOrder.customerId);
      } catch (err: any) {
        const repoErr = err as RepositoryError | undefined;
        this.logger.error("Failed to load customer for swap payment", {
          err,
          orderId,
          customerId: loadedOrder.customerId,
          auditId,
        });
        if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database connection error while loading customer.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database timeout while loading customer.",
          );
        }
        throw new DomainError("INTERNAL_ERROR", "Failed to load customer.");
      }
      if (!customer) {
        throw new DomainError(
          "RESOURCE_NOT_FOUND",
          "Customer not found for swap payment.",
        );
      }
      customerEmail = (customer.email ?? "").trim() || null;
      if (!customerEmail) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Cannot collect swap payment for a customer without an email.",
        );
      }
    }

    // --- Build the swap aggregate
    const swapId = this.idGenerator.generate();
    const swap = new Swap({
      id: swapId,
      orderId: loadedOrder.id,
      returnLineItemId,
      returnQuantity,
      newVariantId,
      newVariantPriceMinor,
      originalValueMinor,
      differenceMinor,
      status: "pending",
      createdAt: startedAt,
      createdBy: actorId,
    });

    // --- Resolve the DURABLE swap (idempotent on the UNIQUE natural key) ------
    // The swap id is regenerated per invocation, so the reservation anchor MUST
    // be the persistent swap's resolved id — otherwise a retry would anchor on a
    // different id and double-reserve. `ensureSwapExists` collides on the
    // natural key and resolves the row committed by the first run.
    const activeSwap = await this.ensureSwapExists(swap);

    // --- Reserve the replacement BEFORE any money moves ----------------------
    // The swap's replacement variant is held through the L9 reservation ledger
    // (INV-I1..INV-I7), anchored on the deterministic swap id with a `swap:`
    // scoped key, ATOMICALLY and idempotently. This guarantees:
    //   - an upcharge is never collected (or a refund issued) for a swap whose
    //     replacement cannot be fulfilled (fail closed on
    //     INSUFFICIENT_INVENTORY / INSUFFICIENT_SINGLE_LOCATION_STOCK);
    //   - a replay of the same swap request replays the SAME hold (never a
    //     second reservation);
    //   - the hold carries a TTL (swept by a future expiry job) so an abandoned
    //     swap returns its units to the available pool without manual action.
    await this.reserveSwapReplacement(activeSwap, actorId);

    const common = {
      order: loadedOrder,
      differenceMinor,
      actorId,
      auditId,
      startedAt,
    };

    if (differenceMinor > 0) {
      return this.collectSwapPayment({
        ...common,
        swap: activeSwap,
        customerEmail: customerEmail as string,
        paymentRedirectBaseUrl,
        orderCurrency: orderCurrency as string,
      });
    }

    if (differenceMinor < 0) {
      return this.dispatchSwapRefund({ ...common, swap: activeSwap });
    }

    return this.recordEvenExchange({ ...common, swap: activeSwap });
  }

  // ---------------------------------------------------------------------------
  // Replacement inventory hold (L9) — reserved BEFORE any money moves
  // ---------------------------------------------------------------------------

  /**
   * Hold the swap's replacement variant through the L9 reservation ledger,
   * anchored on the deterministic swap id with a `swap:`-scoped key.
   *
   * The reserve use case is idempotent on the deterministic key: a re-run of
   * the same swap request replays the SAME hold (never a second reservation) and
   * a changed quantity collides/rejects instead of double-holding. A stock
   * shortfall fails closed (INSUFFICIENT_INVENTORY / INSUFFICIENT_SINGLE_LOCATION_STOCK)
   * BEFORE the payment obligation or refund is created — money never moves for
   * a swap that cannot be fulfilled (INV-I5: inventory never touches money).
   *
   * The hold is NOT auto-released when the swap resolves: an even-exchange or
   * refund swap commits the replacement when it is dispatched (its units stay
   * reserved until finalization confirms them), an upcharge stays held until
   * payment captures and finalization confirms it, and a canceled/abandoned
   * swap returns its units via the TTL sweep or an operator release.
   */
  private async reserveSwapReplacement(swap: Swap, actorId: string): Promise<void> {
    try {
      await this.reserveInventory.execute({
        orderId: swap.id,
        scope: "swap",
        items: [{ variantId: swap.newVariantId, quantity: swap.returnQuantity }],
        expiresAt: new Date(Date.now() + SWAP_RESERVATION_TTL_MS).toISOString(),
        actorId,
      });
    } catch (err: unknown) {
      this.logger.error("Failed to reserve swap replacement inventory", {
        err,
        swapId: swap.id,
        orderId: swap.orderId,
        newVariantId: swap.newVariantId,
        returnQuantity: swap.returnQuantity,
        actorId,
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Customer owes money: durable payment intent + gateway initialization
  // ---------------------------------------------------------------------------

  private async collectSwapPayment(params: {
    swap: Swap;
    order: Order;
    differenceMinor: number;
    customerEmail: string;
    paymentRedirectBaseUrl: string | null;
    actorId: string;
    auditId: string;
    orderCurrency: string;
  }): Promise<ProcessOrderSwapVarianceResult> {
    const {
      swap,
      order,
      differenceMinor,
      customerEmail,
      paymentRedirectBaseUrl,
      actorId,
      auditId,
      orderCurrency,
    } = params;

    // --- Resolve the swap row, then derive the reference from its RESOLVED id ---
    // swap.natural_key is deterministic, but swap.id is generated per invocation.
    // Resolving the persistent swap first (idempotent on the UNIQUE natural key)
    // guarantees the payment reference is stable across re-runs of this request.
    const activeSwap = await this.ensureSwapExists(swap);
    const paymentReference = Payment.buildReference("swap", activeSwap.id);

    // --- Claim the swap + payment obligation (database is the concurrency guard) ---
    const claimed = await this.claimSwapPaymentObligation(
      activeSwap,
      paymentReference,
      order.id,
      orderCurrency,
    );
    const payment = claimed.payment;

    // Never re-contact the gateway for a settled obligation: the swap upcharge
    // has already been captured/refunded, so re-initializing would only create
    // a stale charge session. Represent the settled state instead.
    if (
      payment.status === "captured" ||
      payment.status === "refunded" ||
      payment.status === "partially_refunded"
    ) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Swap payment obligation is already settled; it cannot be re-initialized.",
      );
    }

    // Idempotent replay: the payment already has a customer-facing URL.
    if (payment.providerPaymentUrl) {
      this.logger.info(
        "Swap payment already initialized; replaying existing payment URL",
        {
          swapId: activeSwap.id,
          orderId: order.id,
          paymentId: payment.id,
          paymentReference,
          auditId,
        },
      );
      await this.auditSwap({
        actorId,
        auditId,
        swap: activeSwap,
        orderId: order.id,
        returnLineItemId: swap.returnLineItemId,
        returnQuantity: swap.returnQuantity,
        newVariantId: swap.newVariantId,
        differenceMinor,
      });
      await this.auditSwapPaymentInitialized({
        actorId,
        auditId,
        swap: activeSwap,
        orderId: order.id,
        paymentReference: payment.reference,
        amountMinor: payment.amountMinor,
        currency: payment.currency ?? orderCurrency,
        paymentUrl: payment.providerPaymentUrl,
      });
      return {
        variance: differenceMinor,
        action: "PAYMENT_REQUIRED",
        paymentUrl: payment.providerPaymentUrl,
        swapId: activeSwap.id,
      };
    }

    // --- Call the gateway OUTSIDE any DB transaction, using the typed obligation ---
    // amountMinor, currency, reference, and email come verbatim from the durable
    // obligation + frozen order state; the adapter never recalculates or infers
    // any of them.
    let authorizationUrl: string;
    try {
      const result = await this.paymentService.initializeSwapPayment({
        amountMinor: payment.amountMinor,
        currency: payment.currency ?? orderCurrency,
        reference: payment.reference,
        email: customerEmail,
        returnUrl: paymentRedirectBaseUrl ?? undefined,
        metadata: {
          swapId: activeSwap.id,
          orderId: order.id,
          paymentId: payment.id,
        },
      });
      authorizationUrl = result.authorizationUrl;
      if (!authorizationUrl || typeof authorizationUrl !== "string") {
        throw new DomainError(
          "EXTERNAL_SERVICE_ERROR",
          "Payment service returned an invalid payment URL.",
        );
      }
      payment.markInitialized({
        providerReference: result.providerReference ?? null,
        providerPaymentUrl: authorizationUrl,
      });
    } catch (err: unknown) {
      this.logger.error("Failed to initialize swap payment", {
        err,
        swapId: activeSwap.id,
        orderId: order.id,
        paymentReference,
        auditId,
      });
      throw this.mapGatewayError(err, "initialize swap payment");
    }

    // --- Persist the gateway result (second unit of work) -----------------------
    try {
      await this.transactionManager.execute(async () => {
        await this.paymentRepository.save(payment);
        activeSwap.markAwaitingPayment({
          paymentReference: payment.providerReference ?? payment.reference,
          paymentUrl: authorizationUrl,
        });
        await this.swapRepository.save(activeSwap);
      });
    } catch (err: unknown) {
      // Persistence failed AFTER the gateway accepted the intent. The durable
      // payment obligation (UNIQUE reference) prevents a second charge; the
      // record stays 'initialization_pending' so a later invocation resumes with
      // the SAME reference and Paystack returns the same authorization URL.
      // Attempt best-effort gateway compensation (no-op for Paystack).
      this.logger.error("Failed to persist swap payment result", {
        err,
        swapId: activeSwap.id,
        orderId: order.id,
        paymentReference,
        auditId,
      });
      try {
        if (typeof this.paymentService.cancelTransaction === "function") {
          await this.paymentService
            .cancelTransaction(payment.reference)
            .catch(() => {});
        }
      } catch {
        /* swallow compensation errors */
      }
      throw this.mapPersistenceError(err, "persist swap payment result");
    }

    await this.auditSwap({
      actorId,
      auditId,
      swap: activeSwap,
      orderId: order.id,
      returnLineItemId: swap.returnLineItemId,
      returnQuantity: swap.returnQuantity,
      newVariantId: swap.newVariantId,
      differenceMinor,
    });
    await this.auditSwapPaymentInitialized({
      actorId,
      auditId,
      swap: activeSwap,
      orderId: order.id,
      paymentReference: payment.reference,
      amountMinor: payment.amountMinor,
      currency: payment.currency ?? orderCurrency,
      paymentUrl: authorizationUrl,
    });
    return {
      variance: differenceMinor,
      action: "PAYMENT_REQUIRED",
      paymentUrl: authorizationUrl,
      swapId: activeSwap.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Brand owes money: durable, idempotent refund via the gateway
  // ---------------------------------------------------------------------------

  private async dispatchSwapRefund(params: {
    swap: Swap;
    order: Order;
    differenceMinor: number;
    actorId: string;
    auditId: string;
  }): Promise<ProcessOrderSwapVarianceResult> {
    const { swap, order, differenceMinor, actorId, auditId } = params;
    const refundAmountMinor = Math.abs(differenceMinor);

    if (!order.transactionReference) {
      this.logger.warn(
        "Order missing transactionReference; cannot issue refund automatically",
        { orderId: order.id, swapId: swap.id },
      );
      return this.recordManualRefundReview({
        swap,
        order,
        differenceMinor,
        actorId,
        auditId,
      });
    }

    const refundReference = Refund.buildReference(
      order.transactionReference,
      refundAmountMinor,
    );

    // --- Claim the refund record (cumulative guard + database UNIQUE backstop) ---
    let claimed: { swap: Swap; refund: Refund; created: boolean };
    try {
      claimed = await this.claimSwapRefund({
        swap,
        order,
        refundReference,
        refundAmountMinor,
      });
    } catch (err: unknown) {
      if (err instanceof RefundGuardUnavailableError) {
        // The original captured obligation cannot be resolved, so the
        // "refunds <= captured amount" invariant cannot be enforced
        // authoritatively. Refuse to auto-refund and route to manual review.
        this.logger.warn(
          "Original captured payment not resolvable; routing swap refund to manual review",
          { orderId: order.id, swapId: swap.id, err },
        );
        return this.recordManualRefundReview({
          swap,
          order,
          differenceMinor,
          actorId,
          auditId,
        });
      }
      throw err;
    }
    const activeSwap = claimed.swap;
    const refund = claimed.refund;

    if (!claimed.created) {
      if (refund.status === "dispatched") {
        // Idempotent replay: the refund was already dispatched.
        this.logger.info("Swap refund already dispatched; replaying", {
          swapId: activeSwap.id,
          orderId: order.id,
          refundId: refund.id,
          refundReference,
          auditId,
        });
        try {
          await this.transactionManager.execute(async () => {
            activeSwap.markRefundDispatched();
            await this.swapRepository.save(activeSwap);
          });
        } catch (err: unknown) {
          throw this.mapPersistenceError(err, "record replay refund dispatch");
        }
        await this.auditSwap({
          actorId,
          auditId,
          swap: activeSwap,
          orderId: order.id,
          returnLineItemId: swap.returnLineItemId,
          returnQuantity: swap.returnQuantity,
          newVariantId: swap.newVariantId,
          differenceMinor,
        });
        return {
          variance: differenceMinor,
          action: "REFUND_DISPATCHED",
          paymentUrl: null,
          swapId: activeSwap.id,
        };
      }
      // pending/failed from a previous attempt: the outcome is AMBIGUOUS (the
      // gateway may or may not have refunded). Never re-issue automatically —
      // require operator reconciliation.
      throw new DomainError(
        "REFUND_REQUIRES_REVIEW",
        "A refund for this swap transaction/amount is already recorded as pending; verify with the payment gateway before retrying.",
      );
    }

    // --- Call the gateway OUTSIDE any DB transaction ---
    let providerRefundReference: string | null = null;
    try {
      const result = await this.paymentService.issueRefund(
        order.transactionReference,
        refundAmountMinor,
        {
          // The refund is denominated in the same frozen currency as the
          // original charge (order.currency); the adapter forwards it verbatim.
          currency: order.currency ?? undefined,
          metadata: {
            swapId: activeSwap.id,
            orderId: order.id,
            refundId: refund.id,
          },
        },
      );
      providerRefundReference = result?.providerRefundReference ?? null;
    } catch (err: unknown) {
      // The refund outcome is AMBIGUOUS: a timeout or network failure can mean
      // Paystack ALREADY issued the refund. The durable refund record therefore
      // stays 'pending' (claimed, dispatch unconfirmed) — we do NOT auto-mark it
      // 'failed' (which would falsely assert no refund happened) and we do NOT
      // blindly retry. A later invocation of this same swap request resolves the
      // pending record and surfaces REFUND_REQUIRES_REVIEW so an operator
      // reconciles against Paystack before any manual re-issue.
      this.logger.error("Failed to issue swap refund", {
        err,
        swapId: activeSwap.id,
        orderId: order.id,
        refundReference,
        auditId,
      });
      throw this.mapGatewayError(err, "issue swap refund");
    }

    // --- Resolve the customer recipient for the refund notification (best-effort) ---
    // The financial dispatch NEVER depends on notification data: a missing or
    // unresolvable customer only skips the refund_issued intent. The email is
    // the customer's authoritative committed address — never a body value.
    let customerEmail: string | null = null;
    if (order.customerId) {
      try {
        const customer = await this.customerRepository.findById(order.customerId);
        customerEmail = (customer?.email ?? "").trim() || null;
      } catch (err: unknown) {
        this.logger.warn(
          "Failed to resolve customer for refund notification; skipping intent",
          { err, orderId: order.id, refundId: refund.id, refundReference },
        );
      }
    }

    // --- Persist the dispatched refund + swap state (second unit of work) ------
    // The gateway confirmed the refund OUTSIDE any transaction; this unit of
    // work durably records the dispatch. The `refund_issued` notification
    // intent is appended INSIDE the same transaction (L8 PART 10): it commits
    // atomically with the dispatched transition, so the customer is only ever
    // told "refund completed" AFTER the gateway-confirmed dispatch is durable,
    // and a crash after commit but before enqueue cannot lose it (the outbox
    // sweep relays later). The recipient is resolved best-effort above; an
    // unresolvable recipient only skips the intent — it never blocks the
    // financial dispatch.
    try {
      await this.transactionManager.execute(async () => {
        refund.markDispatched({ providerRefundReference });
        await this.refundRepository.save(refund);
        activeSwap.markRefundDispatched();
        await this.swapRepository.save(activeSwap);

        if (customerEmail && order.currency) {
          const refundIssuedIntent: NotificationIntent = {
            type: "refund_issued",
            payload: {
              recipient: { email: customerEmail },
              order: {
                orderId: order.id,
                cartId: order.cartId,
                customerId: order.customerId,
                currency: order.currency,
                createdAt: order.createdAt,
              },
              refundId: refund.id,
              refundReference: refund.refundReference,
              providerRefundReference: refund.providerRefundReference ?? null,
              money: {
                currency: order.currency,
                amountMinor: refund.amountMinor,
              },
              reason: refund.reason ?? null,
              // The durable dispatch timestamp — the moment the refund became
              // "completed", never a live "now" at send.
              issuedAt: new Date().toISOString(),
            },
          };
          // discriminator = refundReference: deterministic per refund, so the
          // same refund can never be notified twice and distinct refunds for
          // the same order never collide.
          await this.notificationOutboxRepository.append(
            this.idGenerator.generate(),
            refundIssuedIntent,
            { discriminator: refund.refundReference },
          );
        }
      });
    } catch (err: unknown) {
      // Refund WAS issued but its dispatch was not recorded. The refund row is
      // still 'pending', so a retry surfaces REFUND_REQUIRES_REVIEW instead of
      // double-refunding.
      this.logger.error("Failed to record swap refund dispatch", {
        err,
        swapId: activeSwap.id,
        orderId: order.id,
        refundReference,
        auditId,
      });
      throw this.mapPersistenceError(err, "record swap refund dispatch");
    }

    await this.auditSwap({
      actorId,
      auditId,
      swap: activeSwap,
      orderId: order.id,
      returnLineItemId: swap.returnLineItemId,
      returnQuantity: swap.returnQuantity,
      newVariantId: swap.newVariantId,
      differenceMinor,
    });
    return {
      variance: differenceMinor,
      action: "REFUND_DISPATCHED",
      paymentUrl: null,
      swapId: activeSwap.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Even exchange
  // ---------------------------------------------------------------------------

  private async recordEvenExchange(params: {
    swap: Swap;
    order: Order;
    differenceMinor: number;
    actorId: string;
    auditId: string;
  }): Promise<ProcessOrderSwapVarianceResult> {
    const { swap, order, differenceMinor, actorId, auditId } = params;

    let activeSwap = swap;
    try {
      await this.transactionManager.execute(async () => {
        swap.markEvenExchange();
        await this.swapRepository.save(swap);
      });
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // The same swap request already exists; resolve it for an idempotent replay.
        const existing = await this.swapRepository.findByNaturalKey(swap.naturalKey);
        if (existing) {
          activeSwap = existing;
        } else {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Swap already exists but could not be recovered.",
          );
        }
      } else {
        throw this.mapPersistenceError(err, "persist even-exchange swap");
      }
    }

    await this.auditSwap({
      actorId,
      auditId,
      swap: activeSwap,
      orderId: order.id,
      returnLineItemId: swap.returnLineItemId,
      returnQuantity: swap.returnQuantity,
      newVariantId: swap.newVariantId,
      differenceMinor,
    });
    return {
      variance: 0,
      action: "EVEN_EXCHANGE",
      paymentUrl: null,
      swapId: activeSwap.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Idempotency claim helpers (database unique constraints are the guard)
  // ---------------------------------------------------------------------------

  /**
   * Claim the swap's payment obligation (database unique constraints are the
   * guard). The swap must ALREADY be resolved (persisted) by the caller; the
   * obligation is denominated in the order's frozen currency and its amount is
   * the authoritative variance. A duplicate obligation (same swap id) surfaces
   * DUPLICATE and resolves the EXISTING payment for replay/resume.
   */
  private async claimSwapPaymentObligation(
    activeSwap: Swap,
    paymentReference: string,
    orderId: string,
    currency: string,
  ): Promise<{ swap: Swap; payment: Payment }> {
    try {
      await this.transactionManager.execute(async () => {
        const intent = new Payment({
          id: this.idGenerator.generate(),
          obligationType: "swap",
          obligationId: activeSwap.id,
          reference: paymentReference,
          amountMinor: activeSwap.differenceMinor,
          currency,
          subtotalMinor: activeSwap.differenceMinor,
          discountMinor: 0,
          taxMinor: 0,
          shippingMinor: 0,
          insuranceMinor: 0,
          status: "initialization_pending",
          metadata: { orderId, swapId: activeSwap.id },
        });
        await this.paymentRepository.save(intent);
      });
      const claimed = await this.paymentRepository.findByObligation(
        "swap",
        activeSwap.id,
      );
      if (!claimed) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Swap payment obligation was not persisted.",
        );
      }
      return { swap: activeSwap, payment: claimed };
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code !== RepositoryErrorCode.DUPLICATE) {
        throw this.mapPersistenceError(err, "claim swap payment obligation");
      }
      const existingPayment = await this.paymentRepository.findByObligation(
        "swap",
        activeSwap.id,
      );
      if (!existingPayment) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Swap payment obligation could not be claimed.",
        );
      }
      return { swap: activeSwap, payment: existingPayment };
    }
  }

  /**
   * Record that the swap refund cannot be issued automatically and requires
   * operator review. Used when the order lacks a provider transaction reference
   * or when the original captured payment cannot be resolved to enforce the
   * cumulative refund guard. Returns an EVEN_EXCHANGE result carrying no
   * payment URL.
   */
  private async recordManualRefundReview(params: {
    swap: Swap;
    order: Order;
    differenceMinor: number;
    actorId: string;
    auditId: string;
  }): Promise<ProcessOrderSwapVarianceResult> {
    const { swap, order, differenceMinor, actorId, auditId } = params;
    try {
      await this.transactionManager.execute(async () => {
        swap.markRefundPendingManual();
        await this.swapRepository.save(swap);
      });
    } catch (err: unknown) {
      throw this.mapPersistenceError(err, "record manual-refund swap");
    }
    await this.auditSwap({
      actorId,
      auditId,
      swap,
      orderId: order.id,
      returnLineItemId: swap.returnLineItemId,
      returnQuantity: swap.returnQuantity,
      newVariantId: swap.newVariantId,
      differenceMinor,
    });
    return {
      variance: differenceMinor,
      action: "EVEN_EXCHANGE",
      paymentUrl: null,
      swapId: swap.id,
    };
  }

  /**
   * Ensure the swap row exists (idempotent by its UNIQUE natural key), then
   * atomically claim its refund record. A duplicate refund (same provider
   * transaction + amount) surfaces DUPLICATE and resolves the EXISTING refund
   * row. Returns whether this invocation created the record so the caller can
   * distinguish a fresh (safe-to-issue) claim from an existing (ambiguous /
   * already-dispatched) one.
   */
  private async claimSwapRefund(params: {
    swap: Swap;
    order: Order;
    refundReference: string;
    refundAmountMinor: number;
  }): Promise<{ swap: Swap; refund: Refund; created: boolean }> {
    const { swap, order, refundReference, refundAmountMinor } = params;
    const activeSwap = await this.ensureSwapExists(swap);

    try {
      await this.transactionManager.execute(async () => {
        // --- Cumulative refund guard (authoritative, transaction-scoped) ------
        // Lock the original captured payment row FOR UPDATE (blocking) so every
        // refund claim against this obligation serializes on the same row. A
        // concurrent claim waits for the lock and then observes THIS claim's
        // committed refund in the running total before deciding — never a
        // "SELECT remaining, commit, then call the gateway" race.
        const payment = await this.paymentRepository.lockPaymentForUpdate(
          order.transactionReference as string,
        );

        // Idempotent replay: an existing row for this deterministic
        // (transaction, amount) refund reference resolves the prior claim.
        // Checked AFTER the lock so concurrent identical claims serialize and
        // observe the committed row instead of racing past the guard.
        const existing = await this.refundRepository.findByRefundReference(
          refundReference,
        );
        if (existing) {
          throw new SwapRefundAlreadyClaimedError(activeSwap, existing);
        }

        if (
          !payment ||
          (payment.status !== "captured" &&
            payment.status !== "partially_refunded")
        ) {
          // Without the captured obligation the "total refunds <= captured
          // amount" invariant cannot be enforced — route to manual review.
          throw new RefundGuardUnavailableError(activeSwap);
        }

        const refundedMinor = await this.refundRepository.sumRefundedMinor(
          order.transactionReference as string,
        );
        const remainingRefundableMinor = payment.amountMinor - refundedMinor;
        if (
          refundAmountMinor <= 0 ||
          refundAmountMinor > remainingRefundableMinor
        ) {
          throw new DomainError(
            "INVALID_OPERATION",
            `Swap refund of ${refundAmountMinor} exceeds the remaining refundable balance of ${remainingRefundableMinor} for transaction ${order.transactionReference}.`,
          );
        }

        const intent = new Refund({
          id: this.idGenerator.generate(),
          paymentId: payment.id,
          refundReference,
          providerTransactionReference: order.transactionReference as string,
          amountMinor: refundAmountMinor,
          currency: order.currency,
          status: "pending",
          reason: "swap_variance",
          metadata: { swapId: activeSwap.id, orderId: order.id },
        });
        await this.refundRepository.save(intent);
      });

      const saved = await this.refundRepository.findByRefundReference(
        refundReference,
      );
      if (!saved) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Swap refund obligation was not persisted.",
        );
      }
      return { swap: activeSwap, refund: saved, created: true };
    } catch (err: unknown) {
      if (err instanceof SwapRefundAlreadyClaimedError) {
        return { swap: err.swap, refund: err.refund, created: false };
      }
      if (err instanceof RefundGuardUnavailableError) {
        throw err;
      }
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code !== RepositoryErrorCode.DUPLICATE) {
        throw this.mapPersistenceError(err, "claim swap refund");
      }
      // Concurrent identical claim that slipped past the in-tx replay check
      // (database UNIQUE backstop): resolve the existing refund.
      const existingRefund = await this.refundRepository.findByRefundReference(
        refundReference,
      );
      if (!existingRefund) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Swap refund obligation could not be claimed.",
        );
      }
      return {
        swap: activeSwap,
        refund: existingRefund,
        created: false,
      };
    }
  }

  /**
   * Insert the swap row, resolving any pre-existing row with the same UNIQUE
   * natural key. Swap creation is idempotent: a re-run of the same request
   * returns the swap created by the first run instead of duplicating it.
   */
  private async ensureSwapExists(swap: Swap): Promise<Swap> {
    try {
      await this.transactionManager.execute(async () => {
        await this.swapRepository.save(swap);
      });
      return swap;
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code !== RepositoryErrorCode.DUPLICATE) {
        throw this.mapPersistenceError(err, "persist swap");
      }
      const existing = await this.swapRepository.findByNaturalKey(swap.naturalKey);
      if (!existing) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Swap already exists but could not be recovered.",
        );
      }
      return existing;
    }
  }

  // ---------------------------------------------------------------------------
  // Error mapping + audit helpers
  // ---------------------------------------------------------------------------

  private mapPersistenceError(err: unknown, context: string): DomainError {
    const repoErr = err as RepositoryError | undefined;
    if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
      return new DomainError(
        "INVALID_OPERATION",
        "Swap conflict detected; possible duplicate swap.",
      );
    }
    if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
      return new DomainError(
        "INTERNAL_ERROR",
        `Database connection error while ${context}.`,
      );
    }
    if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
      return new DomainError(
        "INTERNAL_ERROR",
        `Database timeout while ${context}.`,
      );
    }
    if (err instanceof DomainError) {
      return err;
    }
    return new DomainError("INTERNAL_ERROR", `Failed to ${context}.`);
  }

  private mapGatewayError(err: unknown, context: string): DomainError {
    const repoErr = err as RepositoryError | undefined;
    if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
      return new DomainError(
        "EXTERNAL_SERVICE_UNAVAILABLE",
        `Payment service unavailable while ${context}.`,
      );
    }
    if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
      return new DomainError(
        "EXTERNAL_SERVICE_TIMEOUT",
        `Payment service timed out while ${context}.`,
      );
    }
    if (err instanceof DomainError) {
      return err;
    }
    return new DomainError(
      "EXTERNAL_SERVICE_ERROR",
      `Payment service failed while ${context}.`,
    );
  }

  private async auditSwap(params: {
    actorId: string;
    auditId: string;
    swap: Swap;
    orderId: string;
    returnLineItemId: string;
    returnQuantity: number;
    newVariantId: string;
    differenceMinor: number;
  }): Promise<void> {
    const {
      actorId,
      auditId,
      swap,
      orderId,
      returnLineItemId,
      returnQuantity,
      newVariantId,
      differenceMinor,
    } = params;
    try {
      await this.auditLogService.logAction(actorId, "SWAP_VARIANCE_PROCESSED", {
        auditId,
        swapId: swap.id,
        orderId,
        returnLineItemId,
        returnQuantity: String(returnQuantity),
        newVariantId,
        differenceMinor: String(differenceMinor),
        status: swap.status,
        processedAt: new Date().toISOString(),
      });
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for swap variance", {
        err: auditErr,
        swapId: swap.id,
        orderId,
      });
    }
  }

  /**
   * Audit a swap upcharge payment initialization. Non-blocking and emitted
   * AFTER the unit of work that persisted the gateway result resolves — an
   * audit failure never rolls back a successfully persisted obligation.
   */
  private async auditSwapPaymentInitialized(params: {
    actorId: string;
    auditId: string;
    swap: Swap;
    orderId: string;
    paymentReference: string;
    amountMinor: number;
    currency: string;
    paymentUrl: string;
  }): Promise<void> {
    const {
      actorId,
      auditId,
      swap,
      orderId,
      paymentReference,
      amountMinor,
      currency,
      paymentUrl,
    } = params;
    try {
      await this.auditLogService.logAction(
        actorId,
        "SWAP_PAYMENT_INITIALIZED",
        {
          auditId,
          swapId: swap.id,
          orderId,
          paymentReference,
          amountMinor: String(amountMinor),
          currency,
          paymentUrl,
          initializedAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for swap payment initialization", {
        err: auditErr,
        swapId: swap.id,
        orderId,
      });
    }
  }
}