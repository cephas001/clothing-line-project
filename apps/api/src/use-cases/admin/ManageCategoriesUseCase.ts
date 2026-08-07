// apps/api/src/use-cases/admin/ManageCategoriesUseCase.ts

import { Category } from "@api/domain/entities/Category";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ICategoryRepository } from "@api/domain/interfaces/repositories/ICategoryRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for creating a category.
 * - adminId is required for audit logging and accountability.
 */
export interface CreateCategoryInput {
  adminId: string;
  name: string;
  parentCategoryId?: string | null;
}

/**
 * Use case: manage categories (create operation).
 *
 * Responsibilities:
 * - Validate and normalize inputs.
 * - Verify parent category exists when provided.
 * - Prevent simple cycles (parent cannot be the same as the new category).
 * - Persist the new category (atomically via the transaction manager).
 * - Map repository errors to DomainError for consistent API surface.
 * - Emit a non-blocking audit log entry.
 * - Log important events and failures via injected logger.
 */
export class ManageCategoriesUseCase {
  constructor(
    private categoryRepository: ICategoryRepository,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  /**
   * Create a new category.
   */
  async executeCreate(input: CreateCategoryInput): Promise<Category> {
    // --- Normalize and validate inputs
    const adminId = (input.adminId ?? "").trim();
    const name = (input.name ?? "").trim();
    const parentCategoryId = input.parentCategoryId
      ? input.parentCategoryId.trim()
      : undefined;

    if (!adminId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "adminId is required for audit logging.",
      );
    }

    if (!name) {
      throw new DomainError("VALIDATION_ERROR", "Category name is required.");
    }

    // Enforce reasonable length limits
    if (name.length > 200) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Category name is too long (max 200 characters).",
      );
    }

    if (parentCategoryId && parentCategoryId.length === 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "parentCategoryId, when provided, must be a non-empty string.",
      );
    }

    // --- Generate id early so we can check for accidental cycles and include in audit
    const newCategoryId = this.idGenerator.generate();

    // Prevent trivial cycle: parent cannot be the same as the new category id
    if (parentCategoryId && parentCategoryId === newCategoryId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "parentCategoryId cannot reference the new category itself.",
      );
    }

    // --- Verify parent hierarchy if provided
    if (parentCategoryId) {
      try {
        const parent = await this.categoryRepository.findById(parentCategoryId);
        if (!parent) {
          throw new DomainError(
            "RESOURCE_NOT_FOUND",
            "Specified parent category does not exist.",
          );
        }
      } catch (err: any) {
        // If it's a DomainError we rethrow it
        if (err instanceof DomainError) throw err;

        // Repository-level failure while fetching parent
        this.logger.error("Failed to fetch parent category", {
          err,
          parentCategoryId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to validate parent category.",
        );
      }
    }

    // --- Instantiate domain entity (domain constructor should validate invariants)
    const newCategory = new Category({
      id: newCategoryId,
      name,
      parentCategoryId: parentCategoryId ?? null,
      createdAt: new Date().toISOString(),
    });

    // --- Persist (atomic via the transaction manager)
    try {
      const saveFn = async () => {
        await this.categoryRepository.save(newCategory);
      };

      await this.transactionManager.execute(saveFn);

      // --- Audit log success (non-blocking)
      try {
        await this.auditLogService.logAction(adminId, "CATEGORY_CREATE", {
          categoryId: newCategory.id,
          name: newCategory.name,
          parentCategoryId: newCategory.parentCategoryId,
        });
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for category creation", {
          err: auditErr,
          categoryId: newCategory.id,
          adminId,
        });
      }

      this.logger.info("Category created", {
        categoryId: newCategory.id,
        name: newCategory.name,
      });
      return newCategory;
    } catch (err: any) {
      // Map repository duplicate constraint to DomainError (covers race condition)
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "A category with the same unique constraint already exists.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while saving category", {
          err,
          name,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving category.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving category", { err, name });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving category.",
        );
      }

      // Fallback: log and wrap unexpected errors
      this.logger.error("Failed to persist category", { err, name });
      throw new DomainError("INTERNAL_ERROR", "Failed to persist category.");
    }
  }
}
