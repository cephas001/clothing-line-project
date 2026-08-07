// apps/api/src/use-cases/cart/RemoveCartLineItemUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Cart } from "@api/domain/entities/Cart";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: remove a line item from a cart.
 *
 * Responsibilities:
 * - Validate inputs.
 * - Ensure the cart exists and the specified line item is present.
 * - Remove the item using domain methods so invariants are preserved.
 * - Persist the cart atomically via the transaction manager.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the removal.
 * - Log structured events and failures for observability.
 */
export class RemoveCartLineItemUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: {
    cartId: string;
    lineItemId: string;
    actorId?: string;
  }): Promise<void> {
    const cartId = (input.cartId ?? "").trim();
    const lineItemId = (input.lineItemId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || null;

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!lineItemId) {
      throw new DomainError("VALIDATION_ERROR", "lineItemId is required.");
    }

    // Load cart
    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart for line item removal", {
        err,
        cartId,
        lineItemId,
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

    // Ensure the line item exists on the cart
    if (!cart.getItem(lineItemId)) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "The specified line item does not exist on the cart.",
      );
    }

    // Prepare persistence operation
    const persist = async () => {
      cart.removeItem(lineItemId);
      await this.cartRepository.save(cart);
    };

    // Persist via the transaction manager
    try {
      await this.transactionManager.execute(persist);

      // Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(
          actorId ?? "system",
          "CART_LINEITEM_REMOVED",
          {
            cartId,
            lineItemId,
            auditId: this.idGenerator.generate(),
            removedAt: new Date().toISOString(),
          },
        );
      } catch (auditErr: unknown) {
        this.logger.warn("Audit log failed for cart line item removal", {
          err: auditErr,
          cartId,
          lineItemId,
          actorId,
        });
      }

      this.logger.info("Removed line item from cart", {
        cartId,
        lineItemId,
        actorId: actorId ?? null,
      });
      return;
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while removing cart line item", {
          err,
          cartId,
          lineItemId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while removing line item.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while removing cart line item", {
          err,
          cartId,
          lineItemId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while removing line item.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.NOT_FOUND) {
        // Possible race: item was removed concurrently
        this.logger.warn("Line item not found during removal persistence", {
          err,
          cartId,
          lineItemId,
        });
        throw new DomainError(
          "RESOURCE_NOT_FOUND",
          "The specified line item no longer exists.",
        );
      }

      this.logger.error("Failed to persist cart after removing line item", {
        err,
        cartId,
        lineItemId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to remove line item from cart.",
      );
    }
  }
}
