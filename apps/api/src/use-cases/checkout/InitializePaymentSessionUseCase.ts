// apps/api/src/use-cases/checkout/InitializePaymentSessionUseCase.ts

import { DomainError } from "#domain/entities/errors/DomainError";
import { ICartRepository } from "#domain/interfaces/repositories/ICartRepository";
import { IPaymentRepository } from "#domain/interfaces/repositories/IPaymentRepository";
import { IPaymentService } from "#domain/interfaces/services/IPaymentService";
import { IAuditLogService } from "#domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "#domain/interfaces/shared/IIdGenerator";
import { ILogger } from "#domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "#domain/interfaces/shared/errors/RepositoryError";
import { Cart } from "@api/domain/entities/Cart";
import { Payment } from "@api/domain/entities/Payment";
import { buildOrderShippingSnapshot } from "@api/domain/shared/shippingSnapshot";
import { ITransactionManager } from "#domain/interfaces/shared/ITransactionManager";
import { IRegionRepository } from "#domain/interfaces/repositories/IRegionRepository";

/**
 * Use case: initialize a payment session for a checkout cart.
 *
 * Responsibilities:
 * - Validate inputs and cart state (cart exists, non-zero total, not already paid).
 * - Require a complete, CURRENT, internally-consistent server-validated shipping
 *   selection (hasShippingSelection + isShippingQuoteCurrent +
 *   isShippingSelectionConsistent) and a region-consistent shipping currency, so
 *   an unselected, stale, or manipulated shipping amount can never become an
 *   authoritative charge.
 * - Claim a DURABLE payment obligation (Payment row keyed by checkout/cartId) in
 *   the database BEFORE contacting the gateway, in the INITIALIZATION_PENDING
 *   state. The database UNIQUE constraints (obligation, reference, provider
 *   reference) are the final concurrency guard: a concurrent or retried
 *   initialization collides instead of double-charging. Because the obligation
 *   is persisted first, a Paystack payment can never exist without a matching
 *   database obligation; because the gateway result is persisted AFTER success,
 *   the pending obligation ensures replay re-initializes with the SAME
 *   deterministic reference (idempotent) rather than leaving a dangling
 *   "Paystack accepted but database lost the result" state.
 * - Exchange transaction parameters with the payment gateway to obtain a client
 *   authorization URL. The gateway receives EXACTLY the authoritative values
 *   from the durable obligation (amountMinor, currency, reference) via the typed
 *   `initializeCheckoutTransaction` contract — the adapter never recalculates
 *   an amount.
 * - Persist the gateway result durably (payment provider reference/URL + cart
 *   payment state) in a second unit of work. The gateway call itself is NOT
 *   assumed transactional with PostgreSQL.
 * - Idempotent replay: an obligation that already carries a payment URL returns
 *   the existing URL without re-contacting the gateway.
 * - Map adapter/repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the initialization attempt.
 */
export interface InitializePaymentSessionInput {
  cartId: string;
  actorId?: string;
  returnUrl?: string; // optional hint for gateway redirect
}

/**
 * Application-level result of payment initialization. Only the redirect target
 * and the deterministic application reference are exposed to the transport
 * boundary; the server-authoritative financial breakdown stays internal.
 */
export interface InitializePaymentSessionResult {
  authorizationUrl: string;
  reference: string;
}

export class InitializePaymentSessionUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly paymentRepository: IPaymentRepository,
    private readonly paymentService: IPaymentService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
    private readonly regionRepository: IRegionRepository,
  ) {}

  async execute(
    input: InitializePaymentSessionInput,
  ): Promise<InitializePaymentSessionResult> {
    const cartId = (input.cartId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";
    const returnUrl = (input.returnUrl ?? "").trim() || undefined;

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }

    // --- Load cart
    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart for payment initialization", {
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

    // --- Cart ownership enforcement (final authorization boundary) -------------
    // A JWT-authenticated customer may ONLY initialize payment for a cart that
    // belongs to them. The authenticated identity originates EXCLUSIVELY from
    // the verified JWT (never the request body — the router resolves it and the
    // use case is the final authority). This check runs BEFORE any financial
    // side effect (the obligation claim / Paystack initialization), so a foreign
    // cart can never produce a payment obligation.
    //   - authenticated + owned cart (cart.customerId === actor)      -> ALLOW
    //   - authenticated + foreign cart (cart.customerId !== actor)    -> REJECT
    //   - authenticated + unowned cart (no cart.customerId)           -> ALLOW
    //     (an unowned cart is not another customer's cart; this preserves the
    //     guest-to-account flow where a logged-in customer pays an unbound cart)
    //   - guest request (no actorId)                                  -> ALLOW
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

    // --- Shipping selection is a required, authoritative checkout component ----
    // The checkout total is only trustworthy when the cart carries a complete,
    // server-validated shipping selection that is (a) present, (b) still current
    // for THIS cart state (the material quote inputs — items, quantities,
    // prices, weight metadata, destination, email, region context — are
    // unchanged since the quotes were obtained), and (c) internally consistent
    // with the server-persisted quote it references. Any gap means a stale or
    // manipulated shipping amount could otherwise become an authoritative
    // charge, so payment MUST NOT initialize.
    //   - no shipping selected          -> INVALID_STATE (select first)
    //   - free shipping (amount 0)      -> allowed (still a valid selection)
    //   - stale quote                   -> INVALID_STATE (re-fetch + re-select)
    //   - cart/address mutated          -> INVALID_STATE (fingerprint mismatch)
    //   - invalid/mismatched courier    -> INVALID_STATE (consistency guard)
    //   - repeated request              -> idempotent replay (unchanged)
    if (!cart.hasShippingSelection) {
      throw new DomainError(
        "INVALID_STATE",
        "A shipping option must be selected before initializing payment.",
      );
    }
    if (!cart.isShippingQuoteCurrent()) {
      throw new DomainError(
        "INVALID_STATE",
        "The cart has changed since shipping quotes were obtained; re-fetch shipping quotes and select again.",
      );
    }
    if (!cart.isShippingSelectionConsistent()) {
      throw new DomainError(
        "INVALID_STATE",
        "The selected shipping option is inconsistent with the latest rate response; re-fetch shipping quotes.",
      );
    }

    // --- Validate cart state
    // ONE authoritative server-side breakdown (subtotal − discount + tax +
    // shipping + insurance). The client never supplies a total, discount, tax,
    // shipping amount, or currency — every component is derived from server
    // state on the cart. The shipping component comes from the DURABLE
    // server-selected shipping state validated above.
    const breakdown = cart.computeAuthoritativeCheckoutBreakdown();
    const chargeTotalMinor = breakdown.totalMinor;
    if (!Number.isFinite(chargeTotalMinor) || chargeTotalMinor <= 0) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot initialize payment for an empty or fully discounted cart.",
      );
    }

    if (cart.isPaymentInitialized()) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Payment session has already been initialized for this cart.",
      );
    }
    if (cart.paymentStatus && cart.paymentStatus === "paid") {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot initialize payment for a cart that is already paid.",
      );
    }
    // A converted cart has already produced an order; initializing another
    // payment session would hand the customer a stale charge URL for an order
    // that already exists.
    if (cart.isConverted()) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot initialize payment for a cart that has already been converted to an order.",
      );
    }

    const region = await this.regionRepository.findById(cart.regionId);

    if (!region) {
      throw new DomainError("REGION_NOT_FOUND", "Region not found.");
    }

    // --- Currency consistency across the whole charge --------------------------
    // The shipping amount is charged in the SELECTED quote's currency
    // (cart.shippingCurrency), but the durable payment obligation and the
    // gateway call use the REGION currency. Summing minor units of different
    // currencies would produce a meaningless total, so the selected quote's
    // currency MUST equal the region currency (compared case-insensitively:
    // the region stores lowercase ISO codes while provider quotes are commonly
    // uppercase). This is the single guard keeping ShippingQuote, the cart
    // selection, the authoritative breakdown, and Payment.amountMinor/currency
    // in one currency.
    if (
      cart.shippingCurrency &&
      cart.shippingCurrency.toUpperCase() !== region.currencyCode.toUpperCase()
    ) {
      throw new DomainError(
        "INVALID_OPERATION",
        "The selected shipping option's currency does not match the region currency.",
      );
    }

    // Paystack requires a customer email on /transaction/initialize. The cart
    // already carries the contact email (set via Cart.assignCustomer / the
    // contact step); this use case supplies it to the gateway payload and
    // fails fast when it is missing rather than delegating the decision to the
    // adapter.
    const customerEmail = (cart.email ?? "").trim();
    if (!customerEmail) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot initialize payment for a cart without a customer email.",
      );
    }

    // --- Deterministic, durable idempotency reference for THIS attempt ---------
    // The reference is derived from the count of prior FAILED checkout
    // obligations. A retry of the SAME attempt (no reset has run, so the count
    // has not changed) keeps the SAME reference — the gateway and the
    // UNIQUE(reference) backstop remain idempotent. After a reset
    // (ResetFailedPaymentInitializationUseCase marks the obligation `failed`)
    // the count increments, producing a NEW reference and therefore a NEW
    // gateway transaction: the gateway is never asked to re-use a reference
    // that already produced a possibly different-amount transaction, while the
    // historical failed row (and its reference/history) is preserved.
    let failedAttemptCount: number;
    try {
      failedAttemptCount = await this.paymentRepository.countFailedByObligation(
        "checkout",
        cartId,
      );
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to resolve payment attempt context", {
        err,
        cartId,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while resolving payment attempts.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while resolving payment attempts.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to resolve payment attempt context.",
      );
    }
    const paymentReference = Payment.buildReference(
      "checkout",
      cartId,
      failedAttemptCount,
    );

    // --- Claim the payment obligation (database is the concurrency guard) ---
    // The obligation is durably persisted as INITIALIZATION_PENDING BEFORE the
    // gateway is contacted (PostgreSQL transactions cannot span the external
    // HTTP call). A crash here leaves a pending obligation that a retry
    // re-initializes with the SAME deterministic reference — Paystack is
    // idempotent on it, so no double charge. A Paystack payment can therefore
    // never exist without a matching database obligation.
    let payment: Payment;
    try {
      payment = await this.transactionManager.execute(async () => {
        const intent = new Payment({
          id: this.idGenerator.generate(),
          obligationType: "checkout",
          obligationId: cartId,
          reference: paymentReference,
          amountMinor: chargeTotalMinor,
          currency: region.currencyCode,
          subtotalMinor: breakdown.subtotalMinor,
          discountMinor: breakdown.discountMinor,
          taxMinor: breakdown.taxMinor,
          shippingMinor: breakdown.shippingMinor,
          insuranceMinor: breakdown.insuranceMinor,
          status: "initialization_pending",
          metadata: {
            cartId,
            auditId: this.idGenerator.generate(),
            // Freeze the charged line items so the finalized order reflects
            // EXACTLY what was agreed at initialization, even if the cart
            // mutates before the webhook arrives.
            lineItems: cart.snapshotChargedLineItems(),
            // Freeze the shipping snapshot (request token, selected courier/
            // service, destination, parcel items) so the finalized order's
            // OrderShippingSnapshot is the EXACT shipping the checkout total
            // was built from — never a reconstruction from today's rates or a
            // mutated cart. A valid selection is guaranteed by the guards above
            // (hasShippingSelection + isShippingQuoteCurrent +
            // isShippingSelectionConsistent).
            shippingSnapshot: buildOrderShippingSnapshot(cart)!,
          },
        });
        await this.paymentRepository.save(intent);
        return intent;
      });
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // A concurrent/previous initialization already claimed this obligation.
        const existing =
          await this.paymentRepository.findByObligation("checkout", cartId);
        if (!existing) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Payment obligation could not be claimed for this cart.",
          );
        }
        payment = existing;
        // A concurrent reset (ResetFailedPaymentInitializationUseCase) marked
        // the obligation `failed` while this request was in flight, so the
        // reference derived above no longer describes a fresh attempt. Fail
        // closed: the client re-runs initialization against the new attempt.
        if (payment.status === "failed") {
          throw new DomainError(
            "INVALID_OPERATION",
            "The payment obligation was reset concurrently; re-run payment initialization.",
          );
        }
      } else {
        this.logger.error("Failed to claim payment obligation", {
          err,
          cartId,
          paymentReference,
        });
        if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database connection error while claiming payment obligation.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database timeout while claiming payment obligation.",
          );
        }
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to claim payment obligation.",
        );
      }
    }

    // A settled obligation must never re-contact the gateway. The durable
    // payment may already be captured/refunded by a downstream flow; creating
    // another session would hand the customer a stale charge URL for money that
    // is already handled. Represent the settled state instead.
    if (
      payment.status === "captured" ||
      payment.status === "refunded" ||
      payment.status === "partially_refunded"
    ) {
      throw new DomainError(
        "INVALID_OPERATION",
        "This cart's payment obligation is already settled.",
      );
    }

    // --- Idempotent replay: the obligation already has a payment URL ----------
    if (payment.providerPaymentUrl) {
      // Capture the URL once: the durable obligation already carries it, so a
      // repeated request returns the SAME application result without ever
      // creating a second financial obligation.
      const existingAuthorizationUrl = payment.providerPaymentUrl;
      try {
        await this.transactionManager.execute(async () => {
          // Mirror the durable record on the cart if it was missed (crash between
          // the payment persist and the cart persist). The guard avoids re-throwing
          // when the cart already carries the initialized state.
          if (!cart.isPaymentInitialized()) {
            cart.markPaymentInitialized({
              authorizationUrl: payment.providerPaymentUrl,
              initializedAt: payment.updatedAt,
              paymentReference: payment.reference,
            });
            await this.cartRepository.save(cart);
          }
        });
      } catch (err: unknown) {
        const repoErr = err as RepositoryError | undefined;
        this.logger.error(
          "Failed to mirror durable payment record onto cart during replay",
          { err, cartId, paymentReference },
        );
        if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database connection error while saving cart.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database timeout while saving cart.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.LOCKED) {
          throw new DomainError(
            "LOCK_ACQUISITION_FAILED",
            "Cart was concurrently modified; retry the request.",
          );
        }
        throw new DomainError("INTERNAL_ERROR", "Failed to persist cart.");
      }

      this.logger.info("Payment session already initialized; replaying", {
        cartId,
        paymentReference,
        paymentId: payment.id,
      });
      await this.auditPaymentInitialized(
        actorId,
        cartId,
        existingAuthorizationUrl,
        payment.amountMinor,
        payment.currency ?? region.currencyCode,
        paymentReference,
        true,
      );
      return {
        authorizationUrl: existingAuthorizationUrl,
        reference: paymentReference,
      };
    }

    // --- Call the gateway OUTSIDE any DB transaction ---------------------------
    // Paystack receives EXACTLY the authoritative values from the durable
    // obligation: amountMinor, currency, and reference are read from `payment`,
    // never from the live cart or a region lookup. The adapter (typed contract
    // CheckoutPaymentObligation) forwards them verbatim and cannot calculate the
    // amount itself. Architecture: authoritative checkout calculation -> durable
    // payment obligation -> Paystack initialization.
    if (!payment.currency) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Checkout payment obligation is missing its authoritative currency.",
      );
    }

    let authorizationUrl: string;
    try {
      const result = await this.paymentService.initializeCheckoutTransaction({
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        reference: payment.reference,
        email: customerEmail,
        returnUrl,
        metadata: {
          cartId,
          paymentId: payment.id,
          auditId: this.idGenerator.generate(),
        },
      });
      authorizationUrl = result.authorizationUrl;
      if (!authorizationUrl || typeof authorizationUrl !== "string") {
        this.logger.error(
          "Payment service returned invalid authorization response",
          { cartId, paymentReference, returned: authorizationUrl },
        );
        throw new DomainError(
          "EXTERNAL_SERVICE_ERROR",
          "Payment service returned an invalid response.",
        );
      }
      // Record the provider's authoritative reference and URL on the intent,
      // transitioning it from initialization_pending to initialized. Persisted
      // in the second unit of work below.
      payment.markInitialized({
        providerReference: result.providerReference ?? null,
        providerPaymentUrl: authorizationUrl,
      });
    } catch (err: unknown) {
      this.logger.error("Payment service initialization failed", {
        err,
        cartId,
        paymentReference,
      });
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "EXTERNAL_SERVICE_UNAVAILABLE",
          "Payment service is unavailable.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "EXTERNAL_SERVICE_TIMEOUT",
          "Payment service timed out while initializing transaction.",
        );
      }

      if (err instanceof DomainError) {
        throw err;
      }

      throw new DomainError(
        "EXTERNAL_SERVICE_ERROR",
        "Failed to initialize payment session.",
      );
    }

    // --- Persist the gateway result (second unit of work) -----------------------
    try {
      await this.transactionManager.execute(async () => {
        await this.paymentRepository.save(payment);
        cart.markPaymentInitialized({
          authorizationUrl,
          initializedAt: new Date().toISOString(),
          paymentReference: payment.reference,
        });
        await this.cartRepository.save(cart);
      });
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist cart after initializing payment", {
        err,
        cartId,
        paymentReference,
        authorizationUrl,
      });

      // Attempt to cancel/rollback the gateway initialization if adapter supports it
      // (best-effort, non-blocking). The durable payment obligation remains, so a
      // later invocation resumes with the SAME reference and cannot double-charge.
      try {
        if (typeof this.paymentService.cancelInitialization === "function") {
          await this.paymentService
            .cancelInitialization({ cartId, authorizationUrl })
            .catch((cancelErr: unknown) => {
              this.logger.warn(
                "Failed to cancel payment initialization after persistence failure (best-effort)",
                { cancelErr, cartId, paymentReference },
              );
            });
        }
      } catch {
        // swallow cancellation errors
      }

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving cart.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving cart.",
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
        "Failed to persist payment initialization state.",
      );
    }

    // --- Audit log (non-blocking)
    await this.auditPaymentInitialized(
      actorId,
      cartId,
      authorizationUrl,
      payment.amountMinor,
      payment.currency ?? region.currencyCode,
      paymentReference,
      false,
    );

    this.logger.info("Payment session initialized", {
      cartId,
      paymentReference,
      authorizationUrl,
      amountMinor: payment.amountMinor,
    });
    return { authorizationUrl, reference: paymentReference };
  }

  private async auditPaymentInitialized(
    actorId: string,
    cartId: string,
    authorizationUrl: string,
    amountMinor: number,
    currency: string,
    paymentReference: string,
    idempotent: boolean,
  ): Promise<void> {
    try {
      await this.auditLogService.logAction(
        actorId,
        idempotent ? "PAYMENT_SESSION_INITIALIZED_IDEMPOTENT" : "PAYMENT_SESSION_INITIALIZED",
        {
          auditId: this.idGenerator.generate(),
          cartId,
          paymentReference,
          authorizationUrl,
          amountMinor: String(amountMinor),
          currency,
          initializedAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for payment session initialization", {
        err: auditErr,
        cartId,
      });
    }
  }
}