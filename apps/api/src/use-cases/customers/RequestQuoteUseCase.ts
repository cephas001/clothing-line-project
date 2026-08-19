// apps/api/src/use-cases/customers/RequestQuoteUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Quote } from "@api/domain/entities/Quote";
import { IQuoteRepository } from "@api/domain/interfaces/repositories/IQuoteRepository";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { Cart } from "@api/domain/entities/Cart";

/**
 * Use case: create a quote request from a customer's cart.
 *
 * Responsibilities:
 * - Validate inputs and ensure the cart belongs to the requesting customer.
 * - Capture a safe cart snapshot (JSON-serializable) for the quote.
 * - Persist the quote record transactionally.
 * - Optionally mark the cart as frozen to prevent concurrent modifications.
 * - Map repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the request.
 * - Log structured events and failures for observability.
 */
export interface RequestQuoteInput {
  cartId: string;
  customerId: string;
  businessUnitId: string;
  customerNotes?: string;
  freezeCart?: boolean;
  actorId?: string;
}

export class RequestQuoteUseCase {
  private static readonly MAX_SNAPSHOT_SIZE = 200_000; // bytes, defensive limit for JSON snapshot

  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly quoteRepository: IQuoteRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: RequestQuoteInput): Promise<void> {
    const cartId = (input.cartId ?? "").trim();
    const customerId = (input.customerId ?? "").trim();
    const businessUnitId = (input.businessUnitId ?? "").trim();
    const customerNotes = (input.customerNotes ?? "").trim() || null;
    const freezeCart = Boolean(input.freezeCart);
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Validate inputs
    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!customerId) {
      throw new DomainError("VALIDATION_ERROR", "customerId is required.");
    }
    if (!businessUnitId) {
      throw new DomainError("VALIDATION_ERROR", "businessUnitId is required.");
    }

    // --- Load cart
    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart for quote request", {
        err,
        cartId,
        customerId,
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
      throw new DomainError("RESOURCE_NOT_FOUND", "Cart not found.");
    }

    // --- Authorization: ensure cart belongs to customer
    if (String(cart.customerId) !== String(customerId)) {
      this.logger.warn("Unauthorized quote request for cart", {
        cartId,
        customerId,
        cartOwner: cart.customerId,
      });
      throw new DomainError(
        "INVALID_OPERATION",
        "Invalid cart or unauthorized access.",
      );
    }

    // --- Business validations: cart must have items
    const items = cart.items;
    if (!items || items.length === 0) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot request a quote for an empty cart.",
      );
    }

    // --- Create a safe cart snapshot
    let cartSnapshot: string;
    try {
      const snapshotObj = cart.toJSON();
      cartSnapshot = JSON.stringify(snapshotObj);
      if (
        Buffer.byteLength(cartSnapshot, "utf8") >
        RequestQuoteUseCase.MAX_SNAPSHOT_SIZE
      ) {
        this.logger.warn(
          "Cart snapshot exceeds maximum allowed size; truncating",
          { cartId },
        );
        // Truncate snapshot defensively to keep it storable
        cartSnapshot = cartSnapshot.slice(
          0,
          RequestQuoteUseCase.MAX_SNAPSHOT_SIZE,
        );
      }
    } catch (err: unknown) {
      this.logger.error("Failed to serialize cart snapshot for quote", {
        err,
        cartId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to capture cart snapshot for quote.",
      );
    }

    // --- Build quote payload
    const quoteId = this.idGenerator.generate();
    const nowIso = new Date().toISOString();
    const quotePayload = new Quote({
      id: quoteId,
      cartId,
      cartSnapshotJson: cartSnapshot,
      businessUnitId,
      notes: customerNotes,
      requestedByCustomerId: customerId,
      requestedAt: nowIso,
    });

    // --- Persist quote and optionally freeze cart (transactional)
    try {
      const work = async () => {
        await this.quoteRepository.save(quotePayload);

        if (freezeCart) {
          cart.markFrozen({ reason: "QUOTE_REQUESTED", frozenAt: nowIso });
          await this.cartRepository.save(cart);
        }
      };

      await this.transactionManager.execute(work);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist quote request", {
        err,
        quoteId,
        cartId,
        customerId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // If a quote with same id or unique constraint exists, surface a domain error
        throw new DomainError(
          "DUPLICATE_QUOTE",
          "A similar quote request already exists.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving quote.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving quote.",
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
        "Failed to create quote request.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "QUOTE_REQUESTED", {
        auditId: this.idGenerator.generate(),
        quoteId,
        cartId,
        customerId,
        businessUnitId,
        freezeCart: String(freezeCart),
        requestedAt: nowIso,
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for quote request", {
        err: auditErr,
        quoteId,
        cartId,
      });
    }

    this.logger.info("Quote requested successfully", {
      quoteId,
      cartId,
      customerId,
      businessUnitId,
    });
    return;
  }
}
