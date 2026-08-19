// apps/api/src/use-cases/cart/UpdateLineItemQuantityUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Cart } from "@api/domain/entities/Cart";
import { CartLineItem } from "@api/domain/entities/CartLineItem";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IVariantRepository } from "@api/domain/interfaces/repositories/IVariantRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: update the quantity of a specific line item on a cart.
 *
 * Responsibilities:
 * - Validate and normalize inputs.
 * - Ensure the cart and line item exist.
 * - Re-evaluate inventory constraints for variant-backed items.
 * - Persist the cart atomically via the transaction manager.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the change.
 * - Log structured events and failures for observability.
 */
export interface UpdateLineItemQuantityInput {
  cartId: string;
  lineItemId: string;
  quantity: number;
  actorId?: string;
}

export class UpdateLineItemQuantityUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: UpdateLineItemQuantityInput): Promise<void> {
    // --- Normalize and validate inputs
    const cartId = (input.cartId ?? "").trim();
    const lineItemId = (input.lineItemId ?? "").trim();
    const quantity = input.quantity;
    const actorId = (input.actorId ?? "").trim() || null;

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!lineItemId) {
      throw new DomainError("VALIDATION_ERROR", "lineItemId is required.");
    }

    // --- Load cart
    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      this.logger.error(
        "Failed to fetch cart while updating line item quantity",
        { err, cartId, lineItemId },
      );
      const repoErr = err as RepositoryError | undefined;
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

    // --- Locate line item on cart
    const lineItem = cart.getItem(lineItemId);

    if (!lineItem) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "Line item not found in this cart.",
      );
    }

    // --- If the line item references a variant, re-evaluate inventory
    let variant = null;
    if (lineItem.variantId) {
      try {
        variant = await this.variantRepository.findById(lineItem.variantId);
      } catch (err: unknown) {
        this.logger.error(
          "Failed to fetch variant while updating line item quantity",
          { err, variantId: lineItem.variantId, cartId, lineItemId },
        );
        const repoErr = err as RepositoryError | undefined;
        if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database connection error while fetching variant.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database timeout while fetching variant.",
          );
        }
        throw new DomainError("INTERNAL_ERROR", "Failed to fetch variant.");
      }

      if (!variant) {
        throw new DomainError(
          "RESOURCE_NOT_FOUND",
          "The variant referenced by the line item does not exist.",
        );
      }

      if (!variant.allowBackorder && variant.inventoryQuantity < quantity) {
        throw new DomainError(
          "OUT_OF_STOCK",
          "Requested quantity exceeds available physical stock.",
        );
      }
    }

    // --- Persist change atomically via the transaction manager
    const persist = async () => {
      lineItem.updateQuantity(quantity);
      await this.cartRepository.save(cart);
    };

    try {
      await this.transactionManager.execute(persist);

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(
          actorId ?? "system",
          "CART_LINEITEM_QUANTITY_UPDATED",
          {
            auditId: this.idGenerator.generate(),
            cartId,
            lineItemId,
            newQuantity: String(quantity),
            variantId: lineItem.variantId ?? "custom",
            updatedAt: new Date().toISOString(),
          },
        );
      } catch (auditErr: unknown) {
        this.logger.warn("Audit log failed for updating line item quantity", {
          err: auditErr,
          cartId,
          lineItemId,
          actorId,
        });
      }

      this.logger.info("Updated line item quantity", {
        cartId,
        lineItemId,
        newQuantity: quantity,
        actorId: actorId ?? null,
      });
      return;
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error(
          "DB connection error while saving cart after quantity update",
          { err, cartId, lineItemId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving cart.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error(
          "DB timeout while saving cart after quantity update",
          { err, cartId, lineItemId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving cart.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.NOT_FOUND) {
        // Possible race: cart or line item removed concurrently
        this.logger.warn(
          "Resource not found during persistence of quantity update",
          { err, cartId, lineItemId },
        );
        throw new DomainError(
          "RESOURCE_NOT_FOUND",
          "Cart or line item no longer exists.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.LOCKED) {
        // Concurrent cart mutation won the race; surface a retryable conflict.
        this.logger.warn("Cart was concurrently modified; retry the request", {
          err,
          cartId,
          lineItemId,
        });
        throw new DomainError(
          "LOCK_ACQUISITION_FAILED",
          "Cart was concurrently modified; retry the request.",
        );
      }

      this.logger.error(
        "Failed to persist cart after updating line item quantity",
        { err, cartId, lineItemId },
      );
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to update line item quantity.",
      );
    }
  }
}
