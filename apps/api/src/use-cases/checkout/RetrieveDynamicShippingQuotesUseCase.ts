// apps/api/src/use-cases/catalog/RetrieveDynamicShippingQuotesUseCase.ts

import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ShippingQuote } from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: fetch dynamic shipping quotes for a cart using an external logistics provider.
 *
 * Responsibilities:
 * - Validate inputs and ensure the cart exists.
 * - Require a valid shipping address on the cart before requesting dynamic rates.
 * - Delegate rate aggregation to the logistics service (e.g., Shipbubble) which uses physical
 *   attributes (weight, dimensions, origin, destination) to compute quotes.
 * - Map repository/service errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the request and returned quote count.
 * - Log structured events and failures for observability.
 */
export interface RetrieveDynamicShippingQuotesInput {
  cartId: string;
  actorId?: string;
}

export class RetrieveDynamicShippingQuotesUseCase {
  private static readonly MAX_QUOTES = 50;

  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly logisticsService: ILogisticsService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(
    input: RetrieveDynamicShippingQuotesInput,
  ): Promise<ShippingQuote[]> {
    const cartId = (input.cartId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }

    // --- Load cart and validate shipping address
    let cart;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart for shipping quotes", {
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

    if (!cart.shippingAddress || typeof cart.shippingAddress !== "object") {
      throw new DomainError(
        "INVALID_STATE",
        "A valid shipping address is required to fetch quotes.",
      );
    }

    // --- Request dynamic rates from logistics service
    let quotes: ShippingQuote[] = [];
    try {
      const rawQuotes = await this.logisticsService.fetchDynamicRates(cart);

      if (!Array.isArray(rawQuotes)) {
        this.logger.warn(
          "Logistics service returned unexpected shape for dynamic rates; normalizing to empty array",
          {
            returnedType: typeof rawQuotes,
            cartId,
          },
        );
        quotes = [];
      } else {
        // Defensive: enforce a sensible maximum to avoid returning huge payloads
        quotes = rawQuotes.slice(
          0,
          RetrieveDynamicShippingQuotesUseCase.MAX_QUOTES,
        );
      }
    } catch (err: unknown) {
      // The logistics service may surface adapter-specific errors; map them conservatively
      this.logger.error(
        "Failed to fetch dynamic shipping rates from logistics service",
        { err, cartId },
      );
      // If the adapter exposes structured error codes, map them here (example shown defensively)
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to contact logistics provider.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Logistics provider timed out while fetching rates.",
        );
      }

      // Generic fallback
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to retrieve shipping quotes.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId,
        "DYNAMIC_SHIPPING_QUOTES_RETRIEVED",
        {
          auditId: this.idGenerator.generate(),
          cartId,
          returnedCount: String(quotes.length),
          retrievedAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn(
        "Audit log failed for dynamic shipping quotes retrieval",
        { err: auditErr, cartId },
      );
    }

    this.logger.info("Dynamic shipping quotes retrieved", {
      cartId,
      returnedCount: quotes.length,
    });
    return quotes;
  }
}
