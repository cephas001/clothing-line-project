// apps/api/src/use-cases/catalog/RetrieveCategoryTreeUseCase.ts

import { Category } from "@api/domain/entities/Category";
import { ICategoryReadRepository } from "@api/domain/interfaces/repositories/ICategoryReadRepository";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: retrieve the category tree for the storefront.
 *
 * Responsibilities:
 * - Validate and normalize input parameters.
 * - Retrieve top-level categories and optionally include nested descendants.
 * - Delegate read-heavy tree construction to the category read repository.
 * - Perform the read operation in a safe, read-only manner and map repository errors to DomainError.
 * - Emit a non-blocking audit log entry recording the retrieval and returned size.
 * - Log structured events and failures for observability.
 */
export interface RetrieveCategoryTreeInput {
  includeDescendants?: boolean;
  actorId?: string;
}

export class RetrieveCategoryTreeUseCase {
  constructor(
    private readonly categoryReadRepository: ICategoryReadRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: RetrieveCategoryTreeInput): Promise<Category[]> {
    const includeDescendants = Boolean(input?.includeDescendants ?? true);
    const actorId = (input?.actorId ?? "").trim() || "system";

    // --- Validate input (defensive)
    if (typeof includeDescendants !== "boolean") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "includeDescendants must be a boolean when provided.",
      );
    }

    // --- Perform read
    let categoryTree: Category[];
    try {
      categoryTree = await this.categoryReadRepository.getTree({
        includeDescendants,
      });

      if (!Array.isArray(categoryTree)) {
        this.logger.warn(
          "Category read repository returned unexpected shape; normalizing to empty array",
          {
            returnedType: typeof categoryTree,
            includeDescendants,
          },
        );
        categoryTree = [];
      }
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("Category read repository connection error", {
          err,
          includeDescendants,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to retrieve category tree due to a repository connection error.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("Category read repository timeout", {
          err,
          includeDescendants,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Category tree retrieval timed out.",
        );
      }

      this.logger.error("Unexpected error while retrieving category tree", {
        err,
        includeDescendants,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to retrieve category tree.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "CATEGORY_TREE_RETRIEVED", {
        auditId: this.idGenerator.generate(),
        includeDescendants: String(includeDescendants),
        returnedCount: String(categoryTree.length),
        retrievedAt: new Date().toISOString(),
      });
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for category tree retrieval", {
        err: auditErr,
        includeDescendants,
      });
    }

    this.logger.info("Category tree retrieved", {
      includeDescendants,
      returnedCount: categoryTree.length,
    });
    return categoryTree;
  }
}
