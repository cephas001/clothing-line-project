// apps/api/src/use-cases/cart/ApplyDiscountCodeUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Promotion } from "@api/domain/entities/Promotion";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { IPromotionRepository } from "@api/domain/interfaces/repositories/IPromotionRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for applying a discount code to a cart.
 * - actorId/adminId is optional but recommended for auditability.
 */
export interface ApplyDiscountCodeInput {
  actorId: string;
  cartId: string;
  code: string;
}

/**
 * Use case: apply a promotion code to a cart.
 *
 * Responsibilities:
 * - Validate and normalize inputs.
 * - Ensure cart exists.
 * - Ensure promotion exists, is active, and cart meets minimum spend.
 * - Prevent duplicate application of the same promotion.
 * - Persist cart atomically via the transaction manager.
 * - Emit a non-blocking audit log entry.
 * - Map repository/adapter errors to DomainError for consistent API surface.
 */
export class ApplyDiscountCodeUseCase {
  constructor(
    private cartRepository: ICartRepository,
    private promotionRepository: IPromotionRepository,
    private auditLogService: IAuditLogService,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: ApplyDiscountCodeInput): Promise<void> {
    // --- Normalize and validate inputs
    const actorId = (input.actorId ?? "").trim();
    const cartId = (input.cartId ?? "").trim();
    const rawCode = (input.code ?? "").trim();
    const code = rawCode.toUpperCase();

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!code) {
      throw new DomainError("VALIDATION_ERROR", "Discount code is required.");
    }
    if (!/^[A-Z0-9-_]+$/.test(code)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Discount code contains invalid characters.",
      );
    }

    // --- Load cart
    let cart;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: any) {
      this.logger.error("Failed to fetch cart while applying discount code", {
        err,
        cartId,
        code,
      });
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch cart.");
    }
    if (!cart) {
      throw new DomainError("CART_NOT_FOUND", "Cart session not found.");
    }

    // --- Load promotion
    let promotionRecord;
    try {
      promotionRecord = await this.promotionRepository.findByCode(code);
    } catch (err: any) {
      this.logger.error(
        "Failed to fetch promotion while applying discount code",
        { err, cartId, code },
      );
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch promotion.");
    }

    if (!promotionRecord || !promotionRecord.isActive) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "The provided discount code is invalid or expired.",
      );
    }

    if (cart.cartTotalMinor < (promotionRecord.minimumSpendMinor ?? 0)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Cart total does not meet the minimum spend requirement for this discount.",
      );
    }

    if (cart.appliedPromotion?.id === promotionRecord.id) {
      throw new DomainError(
        "INVALID_OPERATION",
        "This promotion is already applied to the cart.",
      );
    }

    // --- Build Promotion domain instance to attach to cart
    const appliedPromotion = new Promotion({
      id: promotionRecord.id,
      code: promotionRecord.code,
      discountType: promotionRecord.discountType,
      discountValueMinor: promotionRecord.discountValueMinor,
      minimumSpendMinor: promotionRecord.minimumSpendMinor ?? 0,
      isActive: promotionRecord.isActive,
    });

// --- Persist change atomically via the transaction manager
    try {
      const saveFn = async () => {
        cart.applyDiscount(appliedPromotion);

        await this.cartRepository.save(cart);
      };

      await this.transactionManager.execute(saveFn);

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(actorId, "CART_DISCOUNT_APPLIED", {
          cartId: cart.id,
          promotionId: appliedPromotion.id,
          code: appliedPromotion.code,
          appliedAt: new Date().toISOString(),
        });
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for applying discount code", {
          err: auditErr,
          cartId,
          code,
          actorId,
        });
      }

      this.logger.info("Discount code applied to cart", {
        cartId: cart.id,
        promotionId: appliedPromotion.id,
        code,
      });
      return;
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // Race: another process applied the same promotion concurrently
        throw new DomainError(
          "INVALID_OPERATION",
          "This promotion is already applied to the cart.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error(
          "DB connection error while saving cart with applied discount",
          { err, cartId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving cart.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error(
          "DB timeout while saving cart with applied discount",
          { err, cartId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving cart.",
        );
      }

      // Fallback: log and wrap unexpected errors
      this.logger.error("Failed to persist cart after applying discount code", {
        err,
        cartId,
        code,
      });
      throw new DomainError("INTERNAL_ERROR", "Failed to persist cart.");
    }
  }
}
