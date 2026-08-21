// apps/api/src/use-cases/cart/GetCartUseCase.ts

import { Cart } from "@api/domain/entities/Cart";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: retrieve the current state of a cart (read-only).
 *
 * Responsibilities:
 * - Validate and normalize the cartId input.
 * - Load the cart aggregate through the repository abstraction.
 * - Enforce customer ownership when the cart is bound to a customer: the
 *   authenticated actor (derived from the JWT, never from the request body)
 *   MUST own the cart, or the read is rejected with PERMISSION_DENIED. Guest
 *   reads of unowned carts remain allowed (the OpenAPI operation is public).
 * - Map repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the read.
 * - Return the Cart aggregate for the transport boundary to project.
 */
export interface GetCartInput {
  cartId: string;
  /** Optional JWT-derived actor identity; the ONLY identity source. */
  actorId?: string;
}

export class GetCartUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: GetCartInput): Promise<Cart> {
    const cartId = (input.cartId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || null;

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }

    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart", { err, cartId });

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

    // Ownership: a customer-bound cart is readable only by its owner. A
    // presented identity that differs from the cart's owner is PERMISSION_DENIED
    // — never an existence leak of another customer's resource.
    if (cart.customerId && actorId && actorId !== cart.customerId) {
      throw new DomainError(
        "PERMISSION_DENIED",
        "The authenticated customer does not own this cart.",
      );
    }

    // Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId ?? "system", "CART_RETRIEVED", {
        auditId: this.idGenerator.generate(),
        cartId,
        customerId: cart.customerId ?? null,
        retrievedAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for cart retrieval", {
        err: auditErr,
        cartId,
      });
    }

    this.logger.info("Retrieved cart", {
      cartId,
      actorId: actorId ?? null,
    });
    return cart;
  }
}