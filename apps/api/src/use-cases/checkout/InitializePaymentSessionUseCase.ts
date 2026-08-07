// apps/api/src/use-cases/checkout/InitializePaymentSessionUseCase.ts

import { DomainError } from "#domain/entities/errors/DomainError";
import { ICartRepository } from "#domain/interfaces/repositories/ICartRepository";
import { IPaymentService } from "#domain/interfaces/services/IPaymentService";
import { IAuditLogService } from "#domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "#domain/interfaces/shared/IIdGenerator";
import { ILogger } from "#domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "#domain/interfaces/shared/errors/RepositoryError";
import { Cart } from "@api/domain/entities/Cart";
import { ITransactionManager } from "#domain/interfaces/shared/ITransactionManager";

/**
 * Use case: initialize a payment session for a checkout cart.
 *
 * Responsibilities:
 * - Validate inputs and cart state (cart exists, non-zero total, not already paid).
 * - Exchange transaction parameters with the payment gateway to obtain a client authorization URL or token.
 * - Persist cart state changes (mark payment initialized) transactionally when supported.
 * - Map adapter/repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the initialization attempt and outcome.
 * - Log structured events and failures for observability.
 */
export interface InitializePaymentSessionInput {
  cartId: string;
  actorId?: string;
  returnUrl?: string; // optional hint for gateway redirect
}

export class InitializePaymentSessionUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly paymentService: IPaymentService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: InitializePaymentSessionInput): Promise<string> {
    const cartId = (input.cartId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";
    const returnUrl = (input.returnUrl ?? "").trim() || undefined;

    if (!cartId) {
      throw new DomainError("VALIDATION_ERROR", "cartId is required.");
    }

    // --- Load cart
    let cart: Cart | null;
    try {
      cart = await this.cartRepository.findById(cartId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch cart for payment initialization", {
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

    // --- Validate cart state
    const cartTotalMinor = Number(cart.cartTotalMinor);
    if (!Number.isFinite(cartTotalMinor) || cartTotalMinor <= 0) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot initialize payment for an empty cart.",
      );
    }

    if (cart.isPaymentInitialized()) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Payment session has already been initialized for this cart.",
      );
    }
    if (cart.paymentStatus && cart.paymentStatus === "paid") {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot initialize payment for a cart that is already paid.",
      );
    }

    // --- Prepare gateway payload
    const gatewayPayload: Record<string, unknown> = {
      cartId: cartId,
      amountMinor: cartTotalMinor,
      currency: cart.currency || "NGN",
      metadata: {
        cartId,
        auditId: this.idGenerator.generate(),
      },
    };
    if (returnUrl) {
      gatewayPayload.returnUrl = returnUrl;
    }

    // --- Call payment gateway to initialize transaction
    let authorizationUrl: string;
    try {
      authorizationUrl =
        await this.paymentService.initializeTransaction(gatewayPayload);
      if (!authorizationUrl || typeof authorizationUrl !== "string") {
        this.logger.error(
          "Payment service returned invalid authorization response",
          { cartId, gatewayPayload, returned: authorizationUrl },
        );
        throw new DomainError(
          "EXTERNAL_SERVICE_ERROR",
          "Payment service returned an invalid response.",
        );
      }
    } catch (err: unknown) {
      this.logger.error("Payment service initialization failed", {
        err,
        cartId,
        gatewayPayload,
      });
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "EXTERNAL_SERVICE_UNAVAILABLE",
          "Payment service is unavailable.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "EXTERNAL_SERVICE_TIMEOUT",
          "Payment service timed out while initializing transaction.",
        );
      }

      // If the gateway adapter throws DomainError-like objects, rethrow them
      if (err instanceof DomainError) {
        throw err;
      }

      throw new DomainError(
        "EXTERNAL_SERVICE_ERROR",
        "Failed to initialize payment session.",
      );
    }

    // --- Persist cart state (mark payment initialized) inside a transactional unit of work
    try {
      const persist = async () => {
        cart.markPaymentInitialized({
          authorizationUrl,
          initializedAt: new Date().toISOString(),
        });
        await this.cartRepository.save(cart);
      };

      await this.transactionManager.execute(persist);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist cart after initializing payment", {
        err,
        cartId,
        authorizationUrl,
      });

      // Attempt to cancel/rollback the gateway initialization if adapter supports it (best-effort, non-blocking)
      try {
        if (typeof this.paymentService.cancelInitialization === "function") {
          await this.paymentService
            .cancelInitialization({ cartId, authorizationUrl })
            .catch((cancelErr: unknown) => {
              this.logger.warn(
                "Failed to cancel payment initialization after persistence failure (best-effort)",
                { cancelErr, cartId, authorizationUrl },
              );
            });
        }
      } catch {
        // swallow cancellation errors
      }

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving cart.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving cart.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist payment initialization state.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId,
        "PAYMENT_SESSION_INITIALIZED",
        {
          auditId: this.idGenerator.generate(),
          cartId,
          authorizationUrl,
          amountMinor: String(cartTotalMinor),
          currency: cart.currency || "NGN",
          initializedAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for payment session initialization", {
        err: auditErr,
        cartId,
      });
    }

    this.logger.info("Payment session initialized", {
      cartId,
      authorizationUrl,
      amountMinor: cartTotalMinor,
    });
    return authorizationUrl;
  }
}
