// apps/api/src/use-cases/catalog/SearchProductsUseCase.ts

import { Product } from "@api/domain/entities/Product";
import { ISearchService } from "@api/domain/interfaces/services/ISearchService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: perform a product search within a sales channel and region.
 *
 * Responsibilities:
 * - Validate and normalize the search query and context (salesChannelId, regionId).
 * - Enforce sensible limits to protect the search backend.
 * - Delegate the search to the search service adapter which may call external providers.
 * - Map adapter/service errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the search request and outcome.
 * - Log structured events and failures for observability.
 */
export interface SearchProductsInput {
  query: string;
  salesChannelId: string;
  regionId: string;
  limit?: number;
  actorId?: string;
}

export class SearchProductsUseCase {
  private static readonly DEFAULT_LIMIT = 12;
  private static readonly MAX_LIMIT = 200;

  constructor(
    private readonly searchService: ISearchService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: SearchProductsInput): Promise<Product[]> {
    // --- Normalize and validate inputs
    const rawQuery = (input.query ?? "").trim();
    const salesChannelId = (input.salesChannelId ?? "").trim();
    const regionId = (input.regionId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    if (!rawQuery) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Search query cannot be empty.",
      );
    }
    if (!salesChannelId) {
      throw new DomainError("VALIDATION_ERROR", "salesChannelId is required.");
    }
    if (!regionId) {
      throw new DomainError("VALIDATION_ERROR", "regionId is required.");
    }

    const requestedLimit =
      Number.isInteger(input.limit) && input.limit! > 0
        ? input.limit!
        : SearchProductsUseCase.DEFAULT_LIMIT;
    const limit = Math.min(requestedLimit, SearchProductsUseCase.MAX_LIMIT);

    // --- Execute search
    let results: Product[] = [];
    try {
      results = await this.searchService.search(
        rawQuery,
        salesChannelId,
        regionId,
        limit,
      );

      if (!Array.isArray(results)) {
        this.logger.warn(
          "Search service returned unexpected shape; normalizing to empty array",
          {
            returnedType: typeof results,
            salesChannelId,
            regionId,
            queryPreview: rawQuery.slice(0, 128),
          },
        );
        results = [];
      }
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("Search service connection error", {
          err,
          salesChannelId,
          regionId,
          queryPreview: rawQuery.slice(0, 128),
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to perform search due to a connection error.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("Search service timeout", {
          err,
          salesChannelId,
          regionId,
          queryPreview: rawQuery.slice(0, 128),
        });
        throw new DomainError("INTERNAL_ERROR", "Search request timed out.");
      }

      this.logger.error("Unexpected error while performing product search", {
        err,
        salesChannelId,
        regionId,
        queryPreview: rawQuery.slice(0, 128),
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to perform product search.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "PRODUCT_SEARCH", {
        auditId: this.idGenerator.generate(),
        salesChannelId,
        regionId,
        query: rawQuery.slice(0, 256),
        limit: String(limit),
        returnedCount: String(results.length),
        searchedAt: new Date().toISOString(),
      });
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for product search", {
        err: auditErr,
        salesChannelId,
        regionId,
      });
    }

    this.logger.info("Product search completed", {
      salesChannelId,
      regionId,
      queryPreview: rawQuery.slice(0, 128),
      limit,
      returnedCount: results.length,
    });

    return results;
  }
}
