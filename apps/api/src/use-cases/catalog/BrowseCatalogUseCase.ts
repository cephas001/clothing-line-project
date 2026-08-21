// apps/api/src/use-cases/catalog/BrowseCatalogUseCase.ts

import { Product } from "@api/domain/entities/Product";
import { IProductReadRepository } from "@api/domain/interfaces/repositories/IProductReadRepository";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { IPricingService } from "@api/domain/interfaces/services/IPricingService";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import {
  ProductWithRegionalPricing,
  resolveProductRegionalPricing,
} from "./ProductWithPricing";

/**
 * Use case: retrieve a paginated list of products visible to a specific sales channel and region.
 *
 * Responsibilities:
 * - Validate required context (salesChannelId and regionId).
 * - Normalize and enforce pagination bounds (limit, offset).
 * - Support optional filters: categoryId and searchQuery.
 * - Delegate read-heavy queries to the product read repository which enforces visibility rules.
 * - Resolve each returned variant's AUTHORITATIVE regional price via the pricing
 *   service (fresh from Postgres; never the product read cache).
 * - Return items (each with its priceByVariant map) and total count for client-side pagination.
 * - Map repository/read-adapter/pricing errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry for observability.
 */
export interface BrowseCatalogInput {
  salesChannelId: string;
  regionId: string;
  limit?: number;
  offset?: number;
  categoryId?: string;
  searchQuery?: string;
  actorId?: string;
}

export class BrowseCatalogUseCase {
  private static readonly DEFAULT_LIMIT = 20;
  private static readonly MAX_LIMIT = 200;
  private static readonly MAX_OFFSET = 10_000_000;

  constructor(
    private readonly productReadRepository: IProductReadRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly pricingService: IPricingService,
  ) {}

  async execute(
    input: BrowseCatalogInput,
  ): Promise<{ items: ProductWithRegionalPricing[]; total: number }> {
    // --- Normalize and validate inputs
    const salesChannelId = (input.salesChannelId ?? "").trim();
    const regionId = (input.regionId ?? "").trim();
    const categoryId = input.categoryId ? input.categoryId.trim() : undefined;
    const searchQuery = input.searchQuery
      ? input.searchQuery.trim()
      : undefined;
    const actorId = (input.actorId ?? "").trim() || null;

    const limit =
      Number.isInteger(input.limit) && input.limit! > 0
        ? Math.min(input.limit!, BrowseCatalogUseCase.MAX_LIMIT)
        : BrowseCatalogUseCase.DEFAULT_LIMIT;
    const offset =
      Number.isInteger(input.offset) && input.offset! >= 0
        ? Math.min(input.offset!, BrowseCatalogUseCase.MAX_OFFSET)
        : 0;

    if (!salesChannelId || !regionId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Sales Channel and Region context must be provided.",
      );
    }

    // --- Build repository query payload
    const query = {
      salesChannelId,
      regionId,
      categoryId,
      searchQuery,
      limit,
      offset,
    };

    // --- Execute read operation
    let result: { items: Product[]; total: number };
    try {
      result = await this.productReadRepository.findMany(query);

      // Defensive normalization
      if (
        !result ||
        !Array.isArray(result.items) ||
        typeof result.total !== "number"
      ) {
        this.logger.warn(
          "Product read repository returned unexpected shape; normalizing result",
          {
            returned: typeof result,
            salesChannelId,
            regionId,
            limit,
            offset,
          },
        );
        result = {
          items: Array.isArray(result?.items) ? result.items : [],
          total: Number(result?.total) || 0,
        };
      }
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("Product read repository connection error", {
          err,
          salesChannelId,
          regionId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to query catalog due to a repository connection error.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("Product read repository timeout", {
          err,
          salesChannelId,
          regionId,
        });
        throw new DomainError("INTERNAL_ERROR", "Catalog query timed out.");
      }

      this.logger.error(
        "Unexpected error while querying product read repository",
        { err, salesChannelId, regionId },
      );
      throw new DomainError("INTERNAL_ERROR", "Failed to browse catalog.");
    }

    // --- Resolve the authoritative regional price per variant (fresh from
    // Postgres via the pricing service; never from the product read cache).
    // A pricing failure fails the whole read (fail-closed: prices are never
    // served partially or guessed).
    const items = await Promise.all(
      result.items.map((product) =>
        resolveProductRegionalPricing(
          product,
          regionId,
          this.pricingService,
          this.logger,
        ),
      ),
    );

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId ?? "system",
        "CATALOG_BROWSE",
        {
          auditId: this.idGenerator.generate(),
          salesChannelId,
          regionId,
          categoryId: categoryId ?? "",
          searchQuery: searchQuery ?? "",
          limit: String(limit),
          offset: String(offset),
          returnedCount: String(items.length),
        },
      );
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for catalog browse", {
        err: auditErr,
        salesChannelId,
        regionId,
      });
    }

    this.logger.info("Catalog browse completed", {
      salesChannelId,
      regionId,
      limit,
      offset,
      returnedCount: items.length,
    });

    return { items, total: result.total };
  }
}
