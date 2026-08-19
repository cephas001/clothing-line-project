// apps/api/src/use-cases/admin/AdjustInventoryLevelUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IAuthorizationService } from "@api/domain/interfaces/services/IAuthenticationService";
import { IVariantRepository } from "@api/domain/interfaces/repositories/IVariantRepository";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for adjusting inventory.
 * - adminUserId is required for authorization and audit logging.
 * - adjustmentReason should be provided for auditability.
 */
export interface AdjustInventoryLevelInput {
  adminUserId: string;
  variantId: string;
  newInventoryQuantity: number;
  adjustmentReason: string;
}

/**
 * Use case: Adjust inventory level for a product variant.
 *
 * Responsibilities:
 * - Validate input.
 * - Authorize the admin user for the action.
 * - Ensure the variant exists.
 * - Persist the inventory change (atomically via the transaction manager).
 * - Emit an audit log entry (non-blocking).
 * - Map repository errors to DomainError where appropriate.
 */
export class AdjustInventoryLevelUseCase {
  constructor(
    private variantRepository: IVariantRepository,
    private auditLogService: IAuditLogService,
    private authorizationService: IAuthorizationService,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: AdjustInventoryLevelInput): Promise<void> {
    // --- Input validation and normalization
    const adminUserId = (input.adminUserId ?? "").trim();
    const variantId = (input.variantId ?? "").trim();
    const newQuantity = input.newInventoryQuantity;
    const reason = (input.adjustmentReason ?? "").trim();

    if (!adminUserId) {
      throw new DomainError("VALIDATION_ERROR", "adminUserId is required.");
    }
    if (!variantId) {
      throw new DomainError("VALIDATION_ERROR", "variantId is required.");
    }
    if (!reason) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "adjustmentReason is required for auditability.",
      );
    }

    // --- Authorization
    try {
      await this.authorizationService.authorizeAdmin(
        adminUserId,
        "inventory.adjust",
      );
    } catch (authErr: any) {
      this.logger.warn("Authorization failed for inventory adjustment", {
        adminUserId,
        variantId,
        err: authErr,
      });
      throw new DomainError(
        "UNAUTHORIZED",
        "Admin is not authorized to adjust inventory.",
      );
    }

    // --- Ensure variant exists
    let variant;
    try {
      variant = await this.variantRepository.findById(variantId);
    } catch (err: any) {
      // Repository-level failure while fetching variant
      this.logger.error("Failed to fetch variant", { err, variantId });
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch variant.");
    }

    if (!variant) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Variant not found.");
    }

    const previousQuantity = variant.inventoryQuantity;

    // --- Apply change on the domain entity (domain should validate invariants)
    try {
      // Use domain method for absolute set to bypass normal decrement logic for manual override
      variant.setAbsoluteInventory(newQuantity);
    } catch (err: any) {
      this.logger.error("Domain validation failed when setting inventory", {
        err,
        variantId,
        newQuantity,
      });
      throw new DomainError(
        "VALIDATION_ERROR",
        "Invalid inventory change according to domain rules.",
      );
    }

    // --- Persist change (atomic via the transaction manager)
    try {
      const saveFn = async () => {
        await this.variantRepository.save(variant);
      };

      await this.transactionManager.execute(saveFn);
    } catch (err: any) {
      // Map repository-level errors to DomainError for consistent API surface
      if ((err as RepositoryError)?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while saving variant", {
          err,
          variantId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving variant.",
        );
      }

      if ((err as RepositoryError)?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving variant", {
          err,
          variantId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving variant.",
        );
      }

      // Unknown repository error: log and rethrow as internal error
      this.logger.error("Failed to save variant", { err, variantId });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist inventory change.",
      );
    }

    // --- Audit logging (non-blocking; failures are logged but do not fail the use case)
    try {
      await this.auditLogService.logAction(
        adminUserId,
        "INVENTORY_ADJUSTMENT",
        {
          variantId: variant.id,
          sku: variant.sku,
          previousQuantity,
          newQuantity,
          reason,
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for inventory adjustment", {
        err: auditErr,
        variantId,
        adminUserId,
      });
      // Do not throw; audit failures should not block the main operation
    }

    // --- Final info log
    this.logger.info("Inventory adjusted", {
      variantId: variant.id,
      sku: variant.sku,
      previousQuantity,
      newQuantity,
      adminUserId,
    });
  }
}
