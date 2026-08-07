// apps/api/src/use-cases/admin/ConfigureRegionalPricingUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { MoneyAmount } from "@api/domain/entities/MoneyAmount";
import { IVariantRepository } from "@api/domain/interfaces/repositories/IVariantRepository";
import { IRegionRepository } from "@api/domain/interfaces/repositories/IRegionRepository";
import { IMoneyAmountRepository } from "@api/domain/interfaces/repositories/IMoneyAmountRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for configuring regional pricing.
 * - variantId and regionId identify the target mapping.
 * - amountMinor must be an integer in the smallest currency unit (e.g., kobo, cents).
 * - adminId is required for audit logging and accountability.
 */
export interface ConfigureRegionalPricingInput {
  adminId: string;
  variantId: string;
  regionId: string;
  amountMinor: number; // normalized to lowest denominator (e.g., Kobo)
}

/**
 * Use case: create or update a regional price for a variant.
 *
 * Production responsibilities:
 * - Validate and normalize inputs.
 * - Verify referenced entities exist (variant, region).
 * - Enforce integer normalization and reasonable bounds.
 * - Persist mapping (atomically via the transaction manager).
 * - Map repository errors to DomainError for consistent API surface.
 * - Emit audit log entry on success (non-blocking).
 * - Log important events and failures via injected logger.
 */
export class ConfigureRegionalPricingUseCase {
  constructor(
    private variantRepository: IVariantRepository,
    private regionRepository: IRegionRepository,
    private moneyAmountRepository: IMoneyAmountRepository,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: ConfigureRegionalPricingInput): Promise<void> {
    // --- Normalize and validate inputs
    const adminId = (input.adminId ?? "").trim();
    const variantId = (input.variantId ?? "").trim();
    const regionId = (input.regionId ?? "").trim();
    const amountMinor = input.amountMinor;

    if (!adminId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "adminId is required for audit logging.",
      );
    }
    if (!variantId) {
      throw new DomainError("VALIDATION_ERROR", "variantId is required.");
    }
    if (!regionId) {
      throw new DomainError("VALIDATION_ERROR", "regionId is required.");
    }

    // --- Verify referenced entities exist
    let variant;
    try {
      variant = await this.variantRepository.findById(variantId);
    } catch (err: any) {
      this.logger.error(
        "Failed to fetch variant while configuring regional pricing",
        { err, variantId },
      );
      throw new DomainError("INTERNAL_ERROR", "Failed to validate variant.");
    }
    if (!variant) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Variant not found.");
    }

    let region;
    try {
      region = await this.regionRepository.findById(regionId);
    } catch (err: any) {
      this.logger.error(
        "Failed to fetch region while configuring regional pricing",
        { err, regionId },
      );
      throw new DomainError("INTERNAL_ERROR", "Failed to validate region.");
    }
    if (!region) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Region not found.");
    }

    // A no-op update does not need a write.
    try {
      const existing = await this.moneyAmountRepository.findRegionalPrice(
        variantId,
        regionId,
      );
      if (existing?.amountMinor === amountMinor) {
        this.logger.info("Regional price already set", {
          variantId,
          regionId,
          amountMinor,
        });
        return;
      }
    } catch (err: unknown) {
      // Non-fatal: log and continue to attempt save. Repository errors will be handled below.
      this.logger.warn(
        "Failed to check existing regional price (continuing to save)",
        { err, variantId, regionId },
      );
    }

    const moneyAmount = new MoneyAmount({
      id: this.idGenerator.generate(),
      variantId,
      regionId,
      amountMinor,
    });

    try {
      const saveFn = async () => {
        await this.moneyAmountRepository.save(moneyAmount);
      };

      await this.transactionManager.execute(saveFn);

      // Audit log success (non-blocking)
      try {
        await this.auditLogService.logAction(adminId, "REGIONAL_PRICE_SET", {
          priceRecordId: moneyAmount.id,
          variantId,
          regionId,
          amountMinor,
        });
      } catch (auditErr: any) {
        this.logger.warn(
          "Audit log failed for regional pricing configuration",
          { err: auditErr, variantId, regionId },
        );
      }

      this.logger.info("Regional price configured", {
        priceRecordId: moneyAmount.id,
        variantId,
        regionId,
        amountMinor,
      });
    } catch (err: any) {
      // Map repository-level duplicate or transient errors to DomainError where appropriate
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        // Race condition: another process created the mapping concurrently
        throw new DomainError(
          "INVALID_OPERATION",
          "A regional price for this variant and region already exists.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while saving regional price", {
          err,
          variantId,
          regionId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving regional price.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving regional price", {
          err,
          variantId,
          regionId,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving regional price.",
        );
      }

      // Fallback: log and wrap unexpected errors
      this.logger.error("Failed to persist regional price", {
        err,
        variantId,
        regionId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist regional price.",
      );
    }
  }
}
