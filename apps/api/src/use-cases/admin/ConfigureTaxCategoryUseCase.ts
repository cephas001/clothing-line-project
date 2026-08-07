// apps/api/src/use-cases/admin/ConfigureTaxCategoryUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { TaxCategory } from "@api/domain/entities/TaxCategory";

import { ITaxCategoryRepository } from "@api/domain/interfaces/repositories/ITaxCategoryRepository";
import { IRegionRepository } from "@api/domain/interfaces/repositories/IRegionRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryErrorCode,
  RepositoryError,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface ConfigureTaxCategoryInput {
  adminId: string;
  name: string;
  regionId: string;
  taxRateBasisPoints: number; // e.g., 750 for 7.5%
}

/**
 * Use case responsibilities:
 * - Validate inputs and business rules.
 * - Ensure region exists.
 * - Persist tax category (atomically via the transaction manager).
 * - Map repository errors to DomainError.
 * - Emit audit log entry on success.
 */
export class ConfigureTaxCategoryUseCase {
  constructor(
    private taxCategoryRepository: ITaxCategoryRepository,
    private regionRepository: IRegionRepository,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: ConfigureTaxCategoryInput): Promise<void> {
    // Normalize and validate inputs
    const name = (input.name ?? "").trim();
    const regionId = (input.regionId ?? "").trim();
    const rate = input.taxRateBasisPoints;

    if (!input.adminId || !input.adminId.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "adminId is required for audit logging.",
      );
    }

    if (!name) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax category name is required.",
      );
    }

    if (!regionId) {
      throw new DomainError("VALIDATION_ERROR", "regionId is required.");
    }

    // Ensure region exists
    let region;
    try {
      region = await this.regionRepository.findById(regionId);
    } catch (err: any) {
      this.logger.error("Failed to fetch region", { err, regionId });
      throw new DomainError("INTERNAL_ERROR", "Failed to validate region.");
    }

    if (!region) {
      throw new DomainError(
        "RESOURCE_NOT_FOUND",
        "The specified region does not exist.",
      );
    }

    // Optional early check: avoid duplicate name within region for UX
    try {
      const existing = await this.taxCategoryRepository.findByNameAndRegion(
        name,
        regionId,
      );
      if (existing) {
        throw new DomainError(
          "INVALID_OPERATION",
          "A tax category with this name already exists in the region.",
        );
      }
    } catch (err: any) {
      // If repository threw a RepositoryError, map or rethrow
      if ((err as RepositoryError)?.code) {
        this.logger.error(
          "Repository error while checking existing tax category",
          { err, name, regionId },
        );
        throw err;
      }
      this.logger.error(
        "Unexpected error while checking existing tax category",
        { err, name, regionId },
      );
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to validate tax category uniqueness.",
      );
    }

    // Build domain entity. Domain entity should validate invariants too.
    const taxCategory = new TaxCategory({
      id: this.idGenerator.generate(),
      name,
      regionId,
      rate,
    });

    // Persist atomically via the transaction manager
    try {
      const saveFn = async () => {
        await this.taxCategoryRepository.save(taxCategory);
      };

      await this.transactionManager.execute(saveFn);

      // Audit log success. Audit failures should not block the main flow.
      try {
        await this.auditLogService.logAction(
          input.adminId,
          "TAX_CATEGORY_CREATE",
          {
            taxCategoryId: taxCategory.id,
            name: taxCategory.name,
            regionId: taxCategory.regionId,
            rate: taxCategory.rate,
          },
        );
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for tax category creation", {
          err: auditErr,
          taxCategoryId: taxCategory.id,
        });
      }

      this.logger.info("Tax category configured", {
        taxCategoryId: taxCategory.id,
        regionId: taxCategory.regionId,
      });
    } catch (err: any) {
      // Map repository duplicate error to domain error (covers race conditions)
      if ((err as RepositoryError)?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "A tax category with this name already exists in the region.",
        );
      }

      // Log and wrap unexpected repository errors
      this.logger.error("Failed to save tax category", {
        err,
        taxCategoryId: taxCategory.id,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist tax category.",
      );
    }
  }
}
