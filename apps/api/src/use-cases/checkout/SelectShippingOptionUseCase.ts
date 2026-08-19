// apps/api/src/use-cases/checkout/SelectShippingOptionUseCase.ts

// Use case: "use this shipping option for this cart."
//
// The client supplies ONLY the cart identity and the application quote id they
// saw in the quotes response (cartId + quoteId). The authoritative financial
// values — amountMinor, currency, and the provider selection (courierId,
// serviceCode, requestToken) — are resolved SERVER-SIDE from the quote list
// persisted on the cart at retrieval time (recordShippingQuotes). A client
// payload can therefore never set the shipping amount, currency, or courier,
// and the checkout total always reflects a server-validated quote.
//
// Responsibilities:
// - Validate inputs and cart state (exists, owned, mutable, has an address).
// - Resolve the requested quote from the cart's server-persisted quote list.
// - Apply the selection through the Cart entity — the ONLY writer of the durable
//   shipping selection the checkout total and the dispatch flow trust.
// - Persist the selection transactionally; map repository errors to DomainError.
// - Emit a non-blocking audit log entry recording the selection.
//
// Error contract:
//   400 VALIDATION_ERROR       — missing cartId/quoteId
//   401/403 via router         — ownership is enforced here (PERMISSION_DENIED)
//   404 CART_NOT_FOUND
//   409 INVALID_OPERATION      — frozen / already initialized / paid / converted,
//                                OR an ACTIVE (non-failed) durable payment
//                                obligation exists for the cart (a claimed
//                                obligation freezes the shipping amount +
//                                snapshot; mutation would invalidate it). An
//                                obligation reset to `failed` does NOT block
//                                re-selection.
//   409 INVALID_STATE          — no shipping address, or quote not in the latest
//                                rate response (re-fetch quotes first)
//   500 INTERNAL_ERROR         — persistence/infrastructure failures

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Cart } from "@api/domain/entities/Cart";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IPaymentRepository } from "@api/domain/interfaces/repositories/IPaymentRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface SelectShippingOptionInput {
  cartId: string;
  /** Application quote id from the server's persisted quote list. */
  quoteId: string;
  actorId?: string;
}

/**
 * Application-level result of a shipping selection. Only the selectable quote
 * identity and display fields are returned; provider selection data
 * (courierId/serviceCode/requestToken) stays server-side.
 */
export interface SelectShippingOptionResult {
  quoteId: string;
  serviceLevel?: string | null;
  /** Server-validated shipping amount in minor units, frozen on the cart. */
  amountMinor: number;
  currency?: string | null;
  etaDays?: number | null;
}

export class SelectShippingOptionUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly paymentRepository: IPaymentRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(
    input: SelectShippingOptionInput,
  ): Promise<SelectShippingOptionResult> {
    const cartId = (input.cartId ?? "").trim();
    const quoteId = (input.quoteId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Validate inputs
    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!quoteId) {
      throw new DomainError("VALIDATION_ERROR", "quoteId is required.");
    }

    // --- Load cart
    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart for shipping selection", {
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
    // final authority). A foreign cart can never have its shipping selected.
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

    // --- Cart must be mutable and shippable
    // Selecting shipping changes the authoritative checkout total. It is only
    // legal BEFORE the cart is frozen (B2B quote), before payment is
    // initialized, paid, or converted — otherwise the durable obligation or
    // order would disagree with the new shipping amount.
    if (cart.frozen) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot change shipping for a frozen cart.",
      );
    }
    if (cart.isPaymentInitialized()) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot change shipping after payment has been initialized.",
      );
    }
    if (cart.paymentStatus === "paid") {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot change shipping for a paid cart.",
      );
    }
    if (cart.isConverted()) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot change shipping for a cart that has already been converted to an order.",
      );
    }

    // --- A durable payment obligation freezes the selection -------------------
    // Once an ACTIVE checkout obligation has been claimed for this cart (even
    // while it is still initialization_pending — the window before the cart row
    // is marked initialized), the authoritative charge amount AND the shipping
    // snapshot are FROZEN on that obligation. Allowing a shipping mutation after
    // that point would make the cart disagree with the frozen obligation the
    // gateway was (or will be) asked to charge, and would invalidate the
    // idempotent replay of payment initialization (the cart's selection would no
    // longer match the frozen obligation's). Selection is therefore rejected
    // whenever a non-failed obligation exists — including `initialization_pending`
    // and `initialized` (an abandoned payment page). The ONLY exception is an
    // obligation in the `failed` state: after a reset
    // (ResetFailedPaymentInitializationUseCase) the durable obligation is marked
    // failed (history preserved) and the NEXT initialization derives a fresh
    // per-attempt reference, so selecting a new shipping amount is safe.
    try {
      const existingObligation = await this.paymentRepository.findByObligation(
        "checkout",
        cartId,
      );
      if (existingObligation && existingObligation.status !== "failed") {
        throw new DomainError(
          "INVALID_OPERATION",
          "Cannot change shipping after a payment obligation has been claimed for this cart.",
        );
      }
    } catch (err: unknown) {
      if (err instanceof DomainError) {
        throw err;
      }
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to check payment obligation during shipping selection",
        { err, cartId },
      );
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while checking payment obligation.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while checking payment obligation.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to check payment obligation.",
      );
    }

    if (!cart.shippingAddress || typeof cart.shippingAddress !== "object") {
      throw new DomainError(
        "INVALID_STATE",
        "A shipping address is required before selecting a shipping option.",
      );
    }

    // --- The persisted quote list must still describe THIS cart state ---------
    // Quotes are only valid for the exact cart state they were obtained for.
    // If the cart has materially changed (items, quantities, prices, weight
    // metadata, destination, email, region context) since the quotes were
    // fetched, the stored quote is stale and MUST NOT be selected.
    if (!cart.isShippingQuoteCurrent()) {
      throw new DomainError(
        "INVALID_STATE",
        "The cart has changed since shipping quotes were obtained; re-fetch shipping quotes before selecting.",
      );
    }

    // --- Resolve the requested quote from the server-persisted list -----------
    // The authoritative amount/currency/courier come from THIS list, never from
    // the client. A quoteId the server does not hold is stale or forged.
    const quote = cart.getShippingQuoteById(quoteId);
    if (!quote) {
      throw new DomainError(
        "INVALID_STATE",
        "The requested shipping quote is not in the latest rate response; re-fetch quotes before selecting.",
      );
    }
    const courierId = (quote.courierId ?? "").trim();
    const serviceCode = (quote.serviceCode ?? "").trim();
    const requestToken = (quote.requestToken ?? "").trim();
    if (!courierId || !serviceCode || !requestToken) {
      throw new DomainError(
        "INVALID_STATE",
        "The requested shipping quote is missing provider selection data; re-fetch quotes.",
      );
    }
    if (
      typeof quote.amountMinor !== "number" ||
      !Number.isInteger(quote.amountMinor) ||
      quote.amountMinor < 0
    ) {
      throw new DomainError(
        "INVALID_STATE",
        "The requested shipping quote has an invalid amount; re-fetch quotes.",
      );
    }

    // --- Apply + persist the selection (server-authoritative amount/currency) -
    cart.applySelectedShippingQuote({
      quoteId,
      courierId,
      serviceCode,
      requestToken,
      amountMinor: quote.amountMinor,
      serviceLevel: quote.serviceLevel ?? null,
      currency: quote.currency ?? null,
      etaDays: quote.etaDays ?? null,
    });

    try {
      await this.transactionManager.execute(async () => {
        await this.cartRepository.save(cart);
      });
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist shipping selection on cart", {
        err,
        cartId,
        quoteId,
      });
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
        "Failed to persist shipping selection.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "SHIPPING_OPTION_SELECTED", {
        auditId: this.idGenerator.generate(),
        cartId,
        quoteId,
        amountMinor: String(quote.amountMinor),
        currency: quote.currency ?? null,
        selectedAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for shipping option selection", {
        err: auditErr,
        cartId,
        quoteId,
      });
    }

    this.logger.info("Shipping option selected on cart", {
      cartId,
      quoteId,
      amountMinor: quote.amountMinor,
    });

    return {
      quoteId,
      serviceLevel: quote.serviceLevel ?? null,
      amountMinor: quote.amountMinor,
      currency: quote.currency ?? null,
      etaDays: quote.etaDays ?? null,
    };
  }
}