// apps/api/src/use-cases/catalog/ResolveCrossSellingProductsUseCase.ts

import { Product } from "@api/domain/entities/Product";
import { IRecommendationEngine } from "@api/domain/interfaces/services/IRecommendationEngine";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: resolve cross-selling (related) products for a given product within a channel/region context.
 *
 * Responsibilities:
 * - Validate and normalize inputs (productId, salesChannelId, regionId, limit).
 * - Delegate recommendation resolution to the recommendation engine which respects visibility rules.
 * - Enforce sensible limits to avoid abusive queries.
 * - Map service/repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the recommendation request and outcome.
 * - Log structured events and failures for observability.
 */
export interface ResolveCrossSellingProductsInput {
  productId: string;
  salesChannelId: string;
  regionId: string;
  limit?: number;
  actorId?: string;
}

export class ResolveCrossSellingProductsUseCase {
  private static readonly DEFAULT_LIMIT = 4;
  private static readonly MAX_LIMIT = 50;

  constructor(
    private readonly recommendationEngine: IRecommendationEngine,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: ResolveCrossSellingProductsInput): Promise<Product[]> {
    // --- Normalize and validate inputs
    const productId = (input.productId ?? "").trim();
    const salesChannelId = (input.salesChannelId ?? "").trim();
    const regionId = (input.regionId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    if (!productId) {
      throw new DomainError("VALIDATION_ERROR", "productId is required.");
    }
    if (!salesChannelId) {
      throw new DomainError("VALIDATION_ERROR", "salesChannelId is required.");
    }
    if (!regionId) {
      throw new DomainError("VALIDATION_ERROR", "regionId is required.");
    }

    const rawLimit = Number.isInteger(input.limit)
      ? input.limit!
      : ResolveCrossSellingProductsUseCase.DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(rawLimit, ResolveCrossSellingProductsUseCase.MAX_LIMIT),
    );

    // --- Resolve recommendations
    let recommendations: Product[] = [];
    try {
      recommendations = await this.recommendationEngine.getRelatedProducts(
        productId,
        salesChannelId,
        regionId,
        limit,
      );

      if (!Array.isArray(recommendations)) {
        this.logger.warn(
          "Recommendation engine returned unexpected shape; normalizing to empty array",
          {
            productId,
            salesChannelId,
            regionId,
          },
        );
        recommendations = [];
      }
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("Recommendation engine connection error", {
          err,
          productId,
          salesChannelId,
          regionId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to resolve cross-selling products due to a connection error.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("Recommendation engine timeout", {
          err,
          productId,
          salesChannelId,
          regionId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Recommendation resolution timed out.",
        );
      }

      this.logger.error(
        "Unexpected error while resolving cross-selling products",
        { err, productId, salesChannelId, regionId },
      );
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to resolve cross-selling products.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "CROSS_SELL_RESOLVED", {
        auditId: this.idGenerator.generate(),
        productId,
        salesChannelId,
        regionId,
        requestedLimit: String(limit),
        returnedCount: String(recommendations.length),
        resolvedAt: new Date().toISOString(),
      });
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for cross-sell resolution", {
        err: auditErr,
        productId,
        salesChannelId,
        regionId,
      });
    }

    this.logger.info("Resolved cross-selling products", {
      productId,
      salesChannelId,
      regionId,
      requestedLimit: limit,
      returnedCount: recommendations.length,
    });

    return recommendations;
  }
}
