// apps/api/src/use-cases/admin/CreateProductVariantUseCase.ts
import { ProductVariant } from "@api-domain-entities/ProductVariant";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IProductRepository } from "@api-domain-interfaces/repositories/IProductRepository";
import { IVariantRepository } from "@api-domain-interfaces/repositories/IVariantRepository";
import { IAuditLogService } from "@api-domain-interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api-domain-interfaces/shared/IIdGenerator";
import { ILogger } from "@api-domain-interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api-domain-interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for creating a product variant.
 * - inventoryQuantity must be an integer (whole units).
 * - allowBackorder is explicit to avoid implicit falsy values.
 */
export interface CreateProductVariantInput {
  adminId: string; // who performs the action (for audit)
  productId: string;
  sku: string;
  inventoryQuantity: number;
  allowBackorder: boolean;
}

/**
 * Use case: create a new product variant.
 *
 * Production responsibilities:
 * - Validate and normalize inputs.
 * - Ensure parent product exists.
 * - Enforce SKU uniqueness (fast-fail + DB-level duplicate mapping).
 * - Persist variant (atomically via the transaction manager).
 * - Emit non-blocking audit log entry.
 * - Map repository errors to DomainError for consistent API surface.
 */
export class CreateProductVariantUseCase {
  constructor(
    private variantRepository: IVariantRepository,
    private productRepository: IProductRepository,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: CreateProductVariantInput): Promise<ProductVariant> {
    // --- Normalize and validate inputs
    const adminId = (input.adminId ?? "").trim();
    const productId = (input.productId ?? "").trim();
    const rawSku = (input.sku ?? "").trim();
    const sku = rawSku.toUpperCase(); // normalize SKU to uppercase for global uniqueness
    const inventoryQuantity = input.inventoryQuantity;
    const allowBackorder = Boolean(input.allowBackorder);

    if (!adminId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "adminId is required for audit logging.",
      );
    }
    if (!productId) {
      throw new DomainError("VALIDATION_ERROR", "productId is required.");
    }
    if (!sku) {
      throw new DomainError("VALIDATION_ERROR", "SKU is required.");
    }
    // SKU format: adjust regex to your business rules
    if (!/^[A-Z0-9-_]+$/.test(sku)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "SKU contains invalid characters.",
      );
    }

    // --- Ensure parent product exists
    let parentProduct;
    try {
      parentProduct = await this.productRepository.findById(productId);
    } catch (err: any) {
      this.logger.error("Failed to fetch parent product", { err, productId });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to validate parent product.",
      );
    }
    if (!parentProduct) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "Parent product does not exist.",
      );
    }

    // --- Business rule: SKUs must be globally unique (fast-fail for UX)
    try {
      const existingVariant = await this.variantRepository.findBySku(sku);
      if (existingVariant) {
        throw new DomainError(
          "INVALID_OPERATION",
          "This SKU is already assigned to a variant.",
        );
      }
    } catch (err: any) {
      // If repository threw a RepositoryError, log and rethrow as internal error
      if ((err as RepositoryError)?.code) {
        this.logger.error("Repository error while checking SKU uniqueness", {
          err,
          sku,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to validate SKU uniqueness.",
        );
      }
      // Unexpected error
      this.logger.error("Unexpected error while checking SKU uniqueness", {
        err,
        sku,
      });
      throw err;
    }

    // --- Instantiate the domain entity (domain constructor should validate invariants)
    const newVariant = new ProductVariant({
      id: this.idGenerator.generate(),
      productId,
      sku,
      inventoryQuantity,
      allowBackorder,
    });

    // --- Persist (atomic via the transaction manager)
    try {
      const saveFn = async () => {
        await this.variantRepository.save(newVariant);
      };

      await this.transactionManager.execute(saveFn);

      // --- Audit log (non-blocking)
      try {
        await this.auditLogService.logAction(
          adminId,
          "PRODUCT_VARIANT_CREATE",
          {
            variantId: newVariant.id,
            productId: newVariant.productId,
            sku: newVariant.sku,
            inventoryQuantity: newVariant.inventoryQuantity,
            allowBackorder: newVariant.allowBackorder,
          },
        );
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for product variant creation", {
          err: auditErr,
          variantId: newVariant.id,
        });
      }

      this.logger.info("Product variant created", {
        variantId: newVariant.id,
        sku: newVariant.sku,
      });
      return newVariant;
    } catch (err: any) {
      // Map repository duplicate constraint to DomainError (covers race condition)
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "This SKU is already assigned to a variant.",
        );
      }

      // Map common transient errors to internal error with logging
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while saving variant", {
          err,
          variantId: newVariant.id,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving variant.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving variant", {
          err,
          variantId: newVariant.id,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving variant.",
        );
      }

      // Fallback: log and rethrow as internal error
      this.logger.error("Failed to save product variant", {
        err,
        variantId: newVariant.id,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist product variant.",
      );
    }
  }
}
