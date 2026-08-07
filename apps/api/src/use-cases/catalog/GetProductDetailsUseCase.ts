// apps/api/src/use-cases/catalog/GetProductDetailsUseCase.ts

import { Product } from "@api/domain/entities/Product";
import { IProductReadRepository } from "@api/domain/interfaces/repositories/IProductReadRepository";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: fetch a single product's details within a specific sales channel and region context.
 *
 * Responsibilities:
 * - Validate and normalize inputs (productId, salesChannelId, regionId).
 * - Support optional projection/expansion (fields, expand) while guarding against abusive input.
 * - Delegate the read to the product read repository which enforces visibility and access rules.
 * - Map repository/read-adapter errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the read for observability.
 * - Return the Product domain projection or throw PRODUCT_NOT_FOUND when not visible/absent.
 */
export interface GetProductDetailsInput {
  productId: string;
  salesChannelId: string;
  regionId: string;
  expand?: string[]; // e.g., ['variants', 'variants.options']
  fields?: string[]; // e.g., ['id', 'title', 'thumbnail']
  actorId?: string; // optional: who requested the product (for audit)
}

export class GetProductDetailsUseCase {
  private static readonly MAX_FIELDS = 100;
  private static readonly MAX_EXPANDS = 20;

  constructor(
    private readonly productReadRepository: IProductReadRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: GetProductDetailsInput): Promise<Product> {
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

    const expand =
      Array.isArray(input.expand) && input.expand.length > 0
        ? input.expand
            .map((e) => String(e).trim())
            .filter(Boolean)
            .slice(0, GetProductDetailsUseCase.MAX_EXPANDS)
        : undefined;

    const fields =
      Array.isArray(input.fields) && input.fields.length > 0
        ? input.fields
            .map((f) => String(f).trim())
            .filter(Boolean)
            .slice(0, GetProductDetailsUseCase.MAX_FIELDS)
        : undefined;

    // --- Execute read operation
    let product: Product | null;
    try {
      product = await this.productReadRepository.findByIdAndContext(
        productId,
        salesChannelId,
        regionId,
        expand,
        fields,
      );
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("Product read repository connection error", {
          err,
          productId,
          salesChannelId,
          regionId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to fetch product due to a repository connection error.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("Product read repository timeout", {
          err,
          productId,
          salesChannelId,
          regionId,
        });
        throw new DomainError("INTERNAL_ERROR", "Product lookup timed out.");
      }

      this.logger.error("Unexpected error while fetching product details", {
        err,
        productId,
        salesChannelId,
        regionId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to fetch product details.",
      );
    }

    if (!product) {
      // Product not found or not visible in this channel/region
      throw new DomainError(
        "PRODUCT_NOT_FOUND",
        "The requested product does not exist or is not available in this channel.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "PRODUCT_VIEWED", {
        auditId: this.idGenerator.generate(),
        productId: product.id,
        salesChannelId,
        regionId,
        expand: expand ? expand.join(",") : "",
        fields: fields ? fields.join(",") : "",
        viewedAt: new Date().toISOString(),
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for product view", {
        err: auditErr,
        productId,
        salesChannelId,
        regionId,
      });
    }

    this.logger.info("Fetched product details", {
      productId: product.id,
      salesChannelId,
      regionId,
    });
    return product;
  }
}
