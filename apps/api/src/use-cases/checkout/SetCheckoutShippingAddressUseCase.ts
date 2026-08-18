// apps/api/src/use-cases/checkout/SetCheckoutShippingAddressUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { ITaxCalculationService } from "@api/domain/interfaces/services/ITaxCalculationService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { JsonObject } from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { Cart } from "@api/domain/entities/Cart";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";

/**
 * Use case: set or update the shipping address on a checkout cart and recalculate taxes.
 *
 * Responsibilities:
 * - Validate inputs and normalize the cartId.
 * - Ensure the cart exists.
 * - Apply the shipping address using domain methods so invariants are preserved.
 * - Recalculate regional taxes via the tax calculation service and apply them to the cart.
 * - Persist changes transactionally when the repository supports transactions.
 * - Map repository/service errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the address change and tax outcome.
 * - Log structured events and failures for observability.
 */
export interface SetCheckoutShippingAddressInput {
  cartId: string;
  shippingAddress: JsonObject; // JSONB structure
  actorId?: string;
}

export class SetCheckoutShippingAddressUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly taxService: ITaxCalculationService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: SetCheckoutShippingAddressInput): Promise<void> {
    const cartId = (input.cartId ?? "").trim();
    const shippingAddress = input.shippingAddress;
    const actorId = (input.actorId ?? "").trim() || "system";

    // --- Validate inputs
    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }
    if (!shippingAddress || typeof shippingAddress !== "object") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "shippingAddress must be a valid object.",
      );
    }

    // --- Load cart
    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart for setting shipping address", {
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

    // --- Apply the address and recalculate the AUTHORITATIVE tax --------------
    // The tax service resolves the region rate and applies the single
    // authoritative tax math (calculateTaxAmountMinor) over the gross subtotal.
    // It performs no writes, so it runs OUTSIDE the transactional unit of work.
    // Domain errors from the tax service (e.g. REGION_NOT_FOUND) are preserved;
    // any unexpected failure fails closed as INTERNAL_ERROR.
    cart.setShippingAddress(shippingAddress);

    let applicableTax: number;
    try {
      applicableTax = await this.taxService.calculateTaxForAddress(cart);
    } catch (err: unknown) {
      this.logger.error(
        "Tax service failed while calculating tax for shipping address",
        { err, cartId },
      );
      if (err instanceof DomainError) {
        throw err;
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to calculate taxes for the provided shipping address.",
      );
    }

    cart.applyTax(applicableTax);

    // --- Persist inside a transactional unit of work
    const persist = async () => {
      await this.cartRepository.save(cart);
    };

    // --- Persist inside a transactional unit of work
    try {
      await this.transactionManager.execute(persist);

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(
          actorId,
          "CHECKOUT_SHIPPING_ADDRESS_SET",
          {
            auditId: this.idGenerator.generate(),
            cartId,
            hasShippingAddress: "true",
            taxApplied: cart.taxAmountMinor !== null ? "true" : "false",
            updatedAt: new Date().toISOString(),
          },
        );
      } catch (auditErr: unknown) {
        this.logger.warn(
          "Audit log failed for setting checkout shipping address",
          { err: auditErr, cartId, actorId },
        );
      }

      this.logger.info("Shipping address set on cart and taxes recalculated", {
        cartId,
        actorId,
      });
      return;
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error(
          "DB connection error while saving cart after setting shipping address",
          { err, cartId },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving cart.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error(
          "DB timeout while saving cart after setting shipping address",
          { err, cartId },
        );
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

      this.logger.error(
        "Failed to persist cart after setting shipping address",
        { err, cartId },
      );
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to set shipping address on cart.",
      );
    }
  }
}
