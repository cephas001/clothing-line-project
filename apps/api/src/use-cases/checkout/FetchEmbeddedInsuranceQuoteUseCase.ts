// apps/api/src/use-cases/checkout/FetchEmbeddedInsuranceQuoteUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IInsuranceService } from "@api/domain/interfaces/services/IInsuranceService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { Cart } from "@api/domain/entities/Cart";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";

/**
 * Use case: fetch an embedded insurance premium for the current cart total.
 *
 * Responsibilities:
 * - Validate inputs and ensure the cart exists.
 * - Ensure cart totals are present and expressed in the expected minor unit (integer).
 * - Call the insurance provider adapter to obtain a premium (minor currency units).
 * - Map adapter and repository errors to DomainError with clear domain codes.
 * - Persist any cart-side metadata if required by business rules (transactional when supported).
 * - Emit a non-blocking audit log entry recording the quote request and outcome.
 * - Log structured events and failures for observability.
 */
export interface FetchEmbeddedInsuranceQuoteInput {
  cartId: string;
  actorId?: string;
}

export class FetchEmbeddedInsuranceQuoteUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly insuranceService: IInsuranceService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: FetchEmbeddedInsuranceQuoteInput): Promise<number> {
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
      this.logger.error("Failed to fetch cart for insurance quote", {
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

    // --- Validate cart total (expect integer minor units, e.g., kobo)
    const cartTotalMinor = Number(cart.cartTotalMinor);
    if (!Number.isInteger(cartTotalMinor) || cartTotalMinor < 0) {
      this.logger.error("Invalid cart total for insurance quote", {
        cartId,
        cartTotalMinor,
      });
      throw new DomainError(
        "INVALID_STATE",
        "Cart total is invalid or missing for insurance quote.",
      );
    }

    // --- Request premium from insurance service
    let premiumMinor: number;
    try {
      premiumMinor = await this.insuranceService.getQuote(cartTotalMinor);
    } catch (err: unknown) {
      this.logger.error("Insurance service error while fetching quote", {
        err,
        cartId,
        cartTotalMinor,
      });
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "EXTERNAL_SERVICE_UNAVAILABLE",
          "Insurance provider is unavailable.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "EXTERNAL_SERVICE_TIMEOUT",
          "Insurance provider timed out while fetching quote.",
        );
      }

      // Generic mapping for other adapter/service errors
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to retrieve insurance quote.",
      );
    }

    // Fail-closed: an invalid premium from the provider must NEVER become a
    // financial value in the authoritative checkout breakdown. Normalizing a
    // malformed premium to 0 would silently zero a component of the charge the
    // payment obligation freezes, so the request fails instead.
    if (!Number.isInteger(premiumMinor) || premiumMinor < 0) {
      this.logger.error("Insurance service returned an invalid premium", {
        cartId,
        returnedPremium: premiumMinor,
      });
      throw new DomainError(
        "EXTERNAL_SERVICE_ERROR",
        "Insurance provider returned an invalid premium.",
      );
    }

    // --- Optionally persist quote metadata on cart (non-mandatory)
    try {
      const persist = async () => {
        // Persist the server-computed premium durably on the cart (the
        // authoritative source the checkout total reads) and mirror it into
        // metadata for backwards compatibility.
        cart.recordInsuranceQuote(premiumMinor);
        cart.setMetadata("lastInsuranceQuoteMinor", premiumMinor);
        cart.setMetadata("lastInsuranceQuoteAt", new Date().toISOString());
        await this.cartRepository.save(cart);
      };

      await this.transactionManager.execute(persist);
    } catch (err: unknown) {
      // Persist failure should not block returning a quote; log and continue
      this.logger.warn(
        "Failed to persist insurance quote metadata on cart (non-blocking)",
        { err, cartId, premiumMinor },
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "INSURANCE_QUOTE_FETCHED", {
        auditId: this.idGenerator.generate(),
        cartId,
        cartTotalMinor: String(cartTotalMinor),
        premiumMinor: String(premiumMinor),
        fetchedAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for insurance quote fetch", {
        err: auditErr,
        cartId,
      });
    }

    this.logger.info("Fetched embedded insurance quote", {
      cartId,
      cartTotalMinor,
      premiumMinor,
    });
    return premiumMinor;
  }
}
