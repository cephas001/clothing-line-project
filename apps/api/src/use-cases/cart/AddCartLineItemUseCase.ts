// apps/api/src/use-cases/cart/AddCartLineItemUseCase.ts

import { CartLineItem } from "@api/domain/entities/CartLineItem";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IVariantRepository } from "@api/domain/interfaces/repositories/IVariantRepository";
import { IPricingService } from "@api/domain/interfaces/services/IPricingService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for adding a line item to a cart.
 */
export interface AddCartLineItemInput {
  cartId: string;
  variantId: string;
  quantity: number;
  metadata?: Record<string, unknown>;
  actorId: string; // optional: who initiated the change (for audit)
}

/**
 * Use case: add or update a line item on a cart.
 *
 * Responsibilities:
 * - Validate and normalize inputs.
 * - Ensure cart and variant exist.
 * - Enforce inventory and pricing business rules.
 * - Persist cart atomically via the transaction manager.
 * - Map repository/adapter errors to DomainError.
 * - Emit non-blocking audit log entries and structured logs.
 */
export class AddCartLineItemUseCase {
  constructor(
    private cartRepository: ICartRepository,
    private variantRepository: IVariantRepository,
    private pricingService: IPricingService,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: AddCartLineItemInput): Promise<void> {
    // --- Normalize and validate inputs
    const cartId = (input.cartId ?? "").trim();
    const variantId = (input.variantId ?? "").trim();
    const quantity = input.quantity;
    const metadata = input.metadata ?? {};
    const actorId = (input.actorId ?? "").trim();

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!variantId) {
      throw new DomainError("VALIDATION_ERROR", "variantId is required.");
    }

    // --- Load cart
    let cart;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: any) {
      this.logger.error("Failed to fetch cart", { err, cartId });
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch cart.");
    }
    if (!cart) {
      throw new DomainError(
        "CART_NOT_FOUND",
        "The requested cart session does not exist.",
      );
    }

    // --- Load variant
    let variant;
    try {
      variant = await this.variantRepository.findById(variantId);
    } catch (err: any) {
      this.logger.error("Failed to fetch variant", { err, variantId });
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch variant.");
    }
    if (!variant) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "The specified variant does not exist.",
      );
    }

    // --- Inventory business rule
    if (!variant.allowBackorder && variant.inventoryQuantity < quantity) {
      throw new DomainError(
        "OUT_OF_STOCK",
        "Requested quantity exceeds available physical stock.",
      );
    }

    // --- Pricing: ensure regional price exists for cart's region
    let regionalPriceMinor: number | null;
    try {
      regionalPriceMinor = await this.pricingService.getPriceForRegion(
        variant.id,
        cart.regionId,
      );
    } catch (err: any) {
      this.logger.error("Pricing service error while fetching regional price", {
        err,
        variantId,
        regionId: cart.regionId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to fetch regional price.",
      );
    }

    if (regionalPriceMinor === null) {
      throw new DomainError(
        "REGIONAL_PRICE_MISSING",
        "This variant does not possess a valid price for the cart's region.",
      );
    }

    // --- Build or update line item
    const lineItemId = this.idGenerator.generate();
    const lineItem = new CartLineItem({
      id: lineItemId,
      cartId: cart.id,
      variantId: variant.id,
      quantity,
      unitPriceMinor: regionalPriceMinor,
      metadata,
      createdAt: new Date().toISOString(),
    });

    // --- Persist cart atomically via the transaction manager
    try {
      const saveFn = async () => {
        cart.addOrUpdateItem(lineItem);
        await this.cartRepository.save(cart);
      };

      await this.transactionManager.execute(saveFn);

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(actorId, "CART_LINEITEM_ADD", {
          cartId: cart.id,
          lineItemId: lineItem.id,
          variantId: variant.id,
          quantity,
          unitPriceMinor: regionalPriceMinor,
        });
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for cart line item add", {
          err: auditErr,
          cartId: cart.id,
          lineItemId: lineItem.id,
        });
      }

      this.logger.info("Added/updated cart line item", {
        cartId: cart.id,
        lineItemId: lineItem.id,
        variantId: variant.id,
        quantity,
      });
      return;
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while saving cart", {
          err,
          cartId: cart.id,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving cart.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving cart", {
          err,
          cartId: cart.id,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving cart.",
        );
      }

      // Unknown repository error: log and wrap
      this.logger.error("Failed to persist cart after adding line item", {
        err,
        cartId: cart.id,
      });
      throw new DomainError("INTERNAL_ERROR", "Failed to persist cart.");
    }
  }
}
