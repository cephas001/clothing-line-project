// apps/api/src/use-cases/cart/AddCustomLineItemUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
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
 * Input DTO for adding a custom line item to a cart.
 * - actorId is optional and used for audit logging.
 */
export interface AddCustomLineItemInput {
  cartId: string;
  title: string;
  quantity: number;
  unitPriceMinor: number;
  actorId: string;
}

/**
 * Use case: add a custom (non-variant) line item to a cart.
 *
 * Responsibilities:
 * - Validate and normalize inputs.
 * - Ensure cart exists.
 * - Use domain/cart methods to add the custom item.
 * - Persist cart atomically via the transaction manager.
 * - Map repository errors to DomainError for consistent API surface.
 * - Emit a non-blocking audit log entry.
 * - Log important events and failures via injected logger.
 */
export class AddCustomLineItemUseCase {
  constructor(
    private cartRepository: ICartRepository,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: AddCustomLineItemInput): Promise<void> {
    // --- Normalize and validate inputs
    const cartId = (input.cartId ?? "").trim();
    const title = (input.title ?? "").trim();
    const quantity = input.quantity;
    const unitPriceMinor = input.unitPriceMinor;
    const actorId = (input.actorId ?? "").trim();

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }

    if (!title) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "title is required for a custom line item.",
      );
    }

    if (title.length > 1000) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "title is too long (max 1000 characters).",
      );
    }

    // --- Load cart
    let cart;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: any) {
      this.logger.error("Failed to fetch cart for adding custom line item", {
        err,
        cartId,
      });
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch cart.");
    }

    if (!cart) {
      throw new DomainError("CART_NOT_FOUND", "Cart session not found.");
    }

    // The cart owns custom-item creation so its invariants remain centralized.
    const customItem = {
      id: this.idGenerator.generate(),
      title,
      quantity,
      unitPriceMinor,
      metadata: {}, // reserved for future use; Cart.addCustomItem may accept additional fields
      createdAt: new Date().toISOString(),
    };

    // --- Persist change atomically via the transaction manager
    try {
      const saveFn = async () => {
        cart.addCustomItem(customItem);

        await this.cartRepository.save(cart);
      };

      await this.transactionManager.execute(saveFn);

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(actorId, "CART_CUSTOM_ITEM_ADD", {
          cartId: cart.id,
          customItemId: customItem.id,
          title: customItem.title,
          quantity: customItem.quantity,
          unitPriceMinor: customItem.unitPriceMinor,
        });
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for adding custom cart item", {
          err: auditErr,
          cartId: cart.id,
          customItemId: customItem.id,
        });
      }

      this.logger.info("Custom line item added to cart", {
        cartId: cart.id,
        customItemId: customItem.id,
        title: customItem.title,
        quantity: customItem.quantity,
      });
      return;
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error(
          "DB connection error while saving cart with custom item",
          { err, cartId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving cart.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving cart with custom item", {
          err,
          cartId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving cart.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.LOCKED) {
        this.logger.warn("Cart was concurrently modified; retry the request", {
          err,
          cartId,
        });
        throw new DomainError(
          "LOCK_ACQUISITION_FAILED",
          "Cart was concurrently modified; retry the request.",
        );
      }

      // Unknown repository error: log and wrap
      this.logger.error(
        "Failed to persist cart after adding custom line item",
        { err, cartId },
      );
      throw new DomainError("INTERNAL_ERROR", "Failed to persist cart.");
    }
  }
}
