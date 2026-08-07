// apps/api/src/use-cases/admin/CreatePromotionRuleUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Promotion } from "@api/domain/entities/Promotion";
import { IPromotionRepository } from "@api/domain/interfaces/repositories/IPromotionRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for creating a promotion rule.
 * - adminId is required for audit logging and accountability.
 * - discountValueMinor and minimumSpendMinor are integers in the smallest currency unit.
 * - discountType is either "percentage" (basis points) or "fixed_amount" (minor currency units).
 */
export interface CreatePromotionRuleInput {
  adminId: string;
  code: string;
  discountValueMinor: number; // Normalized integer (basis points for percentage, minor units for fixed)
  discountType: "percentage" | "fixed_amount";
  minimumSpendMinor?: number;
}

/**
 * Use case: create a promotion rule.
 *
 * Responsibilities:
 * - Validate and normalize inputs.
 * - Enforce business rules (unique code, sensible ranges).
 * - Persist the promotion via repository (atomically via the transaction manager).
 * - Map repository errors to DomainError (covers race conditions).
 * - Emit a non-blocking audit log entry.
 * - Log important events and failures via injected logger.
 */
export class CreatePromotionRuleUseCase {
  constructor(
    private promotionRepository: IPromotionRepository,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: CreatePromotionRuleInput): Promise<void> {
    // --- Normalize and validate inputs
    const adminId = (input.adminId ?? "").trim();
    const rawCode = (input.code ?? "").trim();
    const code = rawCode.toUpperCase(); // normalize to uppercase for uniqueness
    const discountValue = input.discountValueMinor;
    const discountType = input.discountType;
    const minimumSpend = input.minimumSpendMinor ?? 0;

    if (!adminId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "adminId is required for audit logging.",
      );
    }

    if (!code) {
      throw new DomainError("VALIDATION_ERROR", "Promotion code is required.");
    }

    // --- Fast-fail uniqueness check for UX (not a substitute for DB unique constraint)
    try {
      const existing = await this.promotionRepository.findByCode(code);
      if (existing) {
        throw new DomainError(
          "INVALID_OPERATION",
          "This promotion code already exists.",
        );
      }
    } catch (err: any) {
      // If repository threw a RepositoryError, log and rethrow as internal error
      if ((err as RepositoryError)?.code) {
        this.logger.error(
          "Repository error while checking promotion code uniqueness",
          { err, code },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to validate promotion code uniqueness.",
        );
      }
      // Unexpected error: log and rethrow
      this.logger.error(
        "Unexpected error while checking promotion code uniqueness",
        { err, code },
      );
      throw err;
    }

    const promotion = new Promotion({
      id: this.idGenerator.generate(),
      code,
      discountValueMinor: discountValue,
      discountType,
      minimumSpendMinor: minimumSpend,
      isActive: true,
    });

    // --- Persist (atomic via the transaction manager)
    try {
      const saveFn = async () => {
        await this.promotionRepository.save(promotion);
      };

      await this.transactionManager.execute(saveFn);

      // --- Audit log success (non-blocking)
      try {
        await this.auditLogService.logAction(adminId, "PROMOTION_CREATE", {
          promotionId: promotion.id,
          code: promotion.code,
          discountValueMinor: promotion.discountValueMinor,
          discountType: promotion.discountType,
          minimumSpendMinor: promotion.minimumSpendMinor,
        });
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for promotion creation", {
          err: auditErr,
          promotionId: promotion.id,
        });
      }

      this.logger.info("Promotion created", {
        promotionId: promotion.id,
        code: promotion.code,
      });
      return;
    } catch (err: any) {
      // Map repository duplicate constraint to DomainError (covers race condition)
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "This promotion code already exists.",
        );
      }

      // Map common transient errors to internal error with logging
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while saving promotion", {
          err,
          code,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving promotion.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving promotion", { err, code });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving promotion.",
        );
      }

      // Fallback: log and wrap unexpected errors
      this.logger.error("Failed to persist promotion", { err, code });
      throw new DomainError("INTERNAL_ERROR", "Failed to persist promotion.");
    }
  }
}
