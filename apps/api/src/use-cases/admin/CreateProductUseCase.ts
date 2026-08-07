// apps/api/src/use-cases/admin/CreateProductUseCase.ts
import { Product } from "@api/domain/entities/Product";
import { DomainError } from "@api/domain/entities/errors/DomainError";

import { IProductRepository } from "@api/domain/interfaces/repositories/IProductRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";

import { normalizeHandle, validateHandle } from "@api/utils/handleUtils";

export interface CreateProductInput {
  adminId: string;
  title: string;
  handle: string;
  description?: string;
}

/**
 * Use case for creating a product.
 *
 * Responsibilities:
 * - Normalize and validate input.
 * - Fast-fail if handle already exists (UX).
 * - Persist product and map repository errors to DomainError.
 * - Write an audit log entry on success.
 *
 * Note: DB-level unique constraint must still exist to guarantee uniqueness
 * under concurrency. The repository implementation should map DB errors to
 * RepositoryError.code (e.g., 'DUPLICATE_HANDLE').
 */
export class CreateProductUseCase {
  constructor(
    private productRepository: IProductRepository,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: CreateProductInput): Promise<Product> {
    // Normalize and validate inputs
    const title = (input.title ?? "").trim();
    const rawHandle = input.handle ?? "";
    const handle = normalizeHandle(rawHandle);
    const description = input.description?.trim();

    // Basic validation with clear DomainError codes/messages
    if (!title) {
      throw new DomainError("VALIDATION_ERROR", "Title is required.");
    }
    if (!handle) {
      throw new DomainError("VALIDATION_ERROR", "Handle is required.");
    }
    if (!validateHandle(handle)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Handle is invalid. Use only letters, numbers, hyphens, or underscores.",
      );
    }

    // Early fast-fail check for UX. This is not a substitute for DB unique constraint.
    try {
      const existing = await this.productRepository.findByHandle(handle);
      if (existing) {
        throw new DomainError(
          "INVALID_OPERATION",
          "A product with this unique handle already exists.",
        );
      }
    } catch (err: any) {
      // If repository threw an unexpected error while checking, log and rethrow
      this.logger.error("Failed to check existing product by handle", {
        err,
        handle,
      });
      throw err;
    }

    // 2. Instantiate the Domain Entity (Enforces internal validation)
    const newProduct = new Product({
      id: this.idGenerator.generate(),
      title: input.title,
      handle: input.handle,
      description: input.description,
    });

    // Persist atomically via the transaction manager.
    try {
      const saveFn = async () => {
        await this.productRepository.save(newProduct);
        return newProduct;
      };

      const result = await this.transactionManager.execute(saveFn);

      // Audit log the successful creation
      try {
        await this.auditLogService.logAction(input.adminId, "PRODUCT_CREATE", {
          productId: newProduct.id,
          title: newProduct.title,
          handle: newProduct.handle,
        });
      } catch (auditErr: any) {
        // Audit failures should not break the main flow, but should be logged.
        this.logger.warn("Audit log failed for product creation", {
          err: auditErr,
          productId: newProduct.id,
        });
      }

      this.logger.info("Product created", {
        productId: newProduct.id,
        handle: newProduct.handle,
      });
      return result;
    } catch (err: any) {
      // Map repository duplicate constraint to a DomainError for consistent API
      // Prefer checking for RepositoryError.code
      if (err?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "A product with this unique handle already exists.",
        );
      }

      // Log unexpected persistence errors and rethrow
      this.logger.error("Failed to save product", {
        err,
        productId: newProduct.id,
      });
      throw err;
    }
  }
}
