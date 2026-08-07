import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface MergeGuestCartToCustomerInput {
  guestCartId: string;
  customerId: string;
  actorId?: string;
}

/**
 * Use case: bind a guest cart to an authenticated customer and merge contents.
 *
 * Responsibilities:
 * - Validate inputs.
 * - Ensure guest cart and customer exist.
 * - If the customer already has an active cart, merge items (best-effort).
 * - Persist changes atomically via the transaction manager.
 * - Map repository errors to DomainError and log appropriately.
 * - Emit a non-blocking audit log entry recording the merge.
 */
export class MergeGuestCartToCustomerUseCase {
  constructor(
    private readonly cartRepository: ICartRepository,
    private readonly customerRepository: ICustomerRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: MergeGuestCartToCustomerInput): Promise<void> {
    const guestCartId = input.guestCartId?.trim();
    const customerId = input.customerId?.trim();

    if (!guestCartId || !customerId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "guestCartId and customerId are required.",
      );
    }

    try {
      const [guestCart, customer] = await Promise.all([
        this.cartRepository.findById(guestCartId),
        this.customerRepository.findById(customerId),
      ]);

      if (!guestCart) {
        throw new DomainError(
          "CART_NOT_FOUND",
          "Guest cart session not found.",
        );
      }
      if (!customer) {
        throw new DomainError("RESOURCE_NOT_FOUND", "Customer not found.");
      }
      if (guestCart.customerId && guestCart.customerId !== customer.id) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Guest cart is already assigned to another customer.",
        );
      }

      const activeCart =
        customer.activeCartId && customer.activeCartId !== guestCart.id
          ? await this.cartRepository.findById(customer.activeCartId)
          : null;

      const targetCart = activeCart ?? guestCart;
      const persist = async () => {
        if (activeCart) {
          activeCart.mergeItemsFrom(guestCart, () =>
            this.idGenerator.generate(),
          );
          await this.cartRepository.save(activeCart);
          await this.cartRepository.delete(guestCart.id);
        } else {
          guestCart.assignCustomer(customer.id, customer.email);
          customer.setActiveCart(guestCart.id);
          await this.cartRepository.save(guestCart);
          await this.customerRepository.save(customer);
        }
      };

      await this.transactionManager.execute(persist);

      await this.logAudit(input.actorId?.trim() || customer.id, {
        guestCartId,
        customerId: customer.id,
        mergedIntoCartId: targetCart.id,
      });
      this.logger.info("Guest cart merged into customer cart", {
        guestCartId,
        customerId: customer.id,
        mergedIntoCartId: targetCart.id,
      });
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        throw error;
      }

      const repositoryError = error as Partial<RepositoryError>;
      this.logger.error("Failed to merge guest cart into customer", {
        error,
        guestCartId,
        customerId,
      });
      if (repositoryError.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "The cart merge conflicts with an existing record.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to merge guest cart.");
    }
  }

  private async logAudit(
    actorId: string,
    details: Record<string, string>,
  ): Promise<void> {
    try {
      await this.auditLogService.logAction(
        actorId,
        "CART_MERGED_TO_CUSTOMER",
        details,
      );
    } catch (error: unknown) {
      this.logger.warn("Audit log failed for cart merge", {
        error,
        ...details,
      });
    }
  }
}
