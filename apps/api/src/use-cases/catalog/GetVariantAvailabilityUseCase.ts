// apps/api/src/use-cases/catalog/GetVariantAvailabilityUseCase.ts

import { IVariantReadRepository } from "@api/domain/interfaces/repositories/IVariantReadRepository";
import { IPricingService } from "@api/domain/interfaces/services/IPricingService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: retrieve availability and regional price information for a single variant.
 *
 * Responsibilities:
 * - Validate and normalize inputs.
 * - Ensure the variant exists and is visible to the caller (read repository enforces visibility).
 * - Query the pricing service for a regional price (may return null when no price exists).
 * - Map repository and service errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the availability check.
 * - Log structured events and failures for observability.
 */
export interface GetVariantAvailabilityInput {
  variantId: string;
  regionId: string;
  actorId?: string;
}

export interface VariantAvailabilityDTO {
  variantId: string;
  inventoryQuantity: number;
  allowBackorder: boolean;
  priceMinor: number | null;
}

export class GetVariantAvailabilityUseCase {
  constructor(
    private readonly variantReadRepository: IVariantReadRepository,
    private readonly pricingService: IPricingService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(
    input: GetVariantAvailabilityInput,
  ): Promise<VariantAvailabilityDTO> {
    // --- Normalize and validate inputs
    const variantId = (input.variantId ?? "").trim();
    const regionId = (input.regionId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";

    if (!variantId) {
      throw new DomainError("VALIDATION_ERROR", "variantId is required.");
    }
    if (!regionId) {
      throw new DomainError("VALIDATION_ERROR", "regionId is required.");
    }

    // --- Fetch variant (read repository enforces visibility rules)
    let variant;
    try {
      variant = await this.variantReadRepository.findById(variantId);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("Variant read repository connection error", {
          err,
          variantId,
          regionId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to fetch variant due to a repository connection error.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("Variant read repository timeout", {
          err,
          variantId,
          regionId,
        });
        throw new DomainError("INTERNAL_ERROR", "Variant lookup timed out.");
      }

      this.logger.error("Unexpected error while fetching variant", {
        err,
        variantId,
        regionId,
      });
      throw new DomainError("INTERNAL_ERROR", "Failed to fetch variant.");
    }

    if (!variant) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Variant not found.");
    }

    // --- Fetch regional price (pricing service may return null)
    let regionalPriceMinor: number | null = null;
    try {
      regionalPriceMinor = await this.pricingService.getPriceForRegion(
        variant.id,
        regionId,
      );
    } catch (err: any) {
      this.logger.error("Pricing service error while fetching regional price", {
        err,
        variantId: variant.id,
        regionId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to fetch regional price.",
      );
    }

    const dto: VariantAvailabilityDTO = {
      variantId: variant.id,
      inventoryQuantity: Number(variant.inventoryQuantity ?? 0),
      allowBackorder: Boolean(variant.allowBackorder),
      priceMinor: regionalPriceMinor,
    };

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId,
        "VARIANT_AVAILABILITY_CHECK",
        {
          auditId: this.idGenerator.generate(),
          variantId: dto.variantId,
          regionId,
          inventoryQuantity: String(dto.inventoryQuantity),
          allowBackorder: String(dto.allowBackorder),
          priceMinor: dto.priceMinor === null ? "null" : String(dto.priceMinor),
          checkedAt: new Date().toISOString(),
        },
      );
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for variant availability check", {
        err: auditErr,
        variantId: dto.variantId,
        regionId,
      });
    }

    this.logger.info("Variant availability retrieved", {
      variantId: dto.variantId,
      regionId,
      inventoryQuantity: dto.inventoryQuantity,
      priceMinor: dto.priceMinor,
    });
    return dto;
  }
}
