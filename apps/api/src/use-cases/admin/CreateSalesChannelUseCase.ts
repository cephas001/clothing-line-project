// apps/api/src/use-cases/admin/CreateSalesChannelUseCase.ts

import { SalesChannel } from "@api-domain-entities/SalesChannel";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ISalesChannelRepository } from "@api-domain-interfaces/repositories/ISalesChannelRepository";
import { IAuditLogService } from "@api-domain-interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api-domain-interfaces/shared/IIdGenerator";
import { ILogger } from "@api-domain-interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api-domain-interfaces/shared/errors/RepositoryError";

/**
 * Input DTO for creating a sales channel.
 * - adminId is required for audit logging and accountability.
 * - isDisabled defaults to false when omitted.
 */
export interface CreateSalesChannelInput {
  adminId: string;
  name: string;
  description?: string;
  isDisabled?: boolean;
}

/**
 * Use case: create a new sales channel.
 *
 * Production responsibilities:
 * - Validate and normalize inputs.
 * - Instantiate domain entity (domain should enforce invariants).
 * - Persist via repository (atomically via the transaction manager).
 * - Map repository errors to DomainError (covers race conditions).
 * - Emit non-blocking audit log entry.
 * - Log important events and failures via injected logger.
 */
export class CreateSalesChannelUseCase {
  constructor(
    private salesChannelRepository: ISalesChannelRepository,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
    private transactionManager: ITransactionManager,
  ) {}

  async execute(input: CreateSalesChannelInput): Promise<SalesChannel> {
    // --- Normalize and validate inputs
    const adminId = (input.adminId ?? "").trim();
    const name = (input.name ?? "").trim();
    const description = input.description?.trim() ?? "";
    const isDisabled = Boolean(input.isDisabled);

    if (!adminId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "adminId is required for audit logging.",
      );
    }

    if (!name) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Sales channel name is required.",
      );
    }

    // Enforce reasonable length limits to avoid DB/UX issues
    if (name.length > 200) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Sales channel name is too long (max 200 characters).",
      );
    }
    if (description.length > 2000) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Description is too long (max 2000 characters).",
      );
    }

    // --- Instantiate domain entity (domain constructor should validate invariants)
    const newChannel = new SalesChannel({
      id: this.idGenerator.generate(),
      name,
      description,
      isDisabled,
      createdAt: new Date().toISOString(),
    });

    // --- Persist (atomic via the transaction manager)
    try {
      const saveFn = async () => {
        await this.salesChannelRepository.save(newChannel);
      };

      await this.transactionManager.execute(saveFn);

      // --- Audit log success (non-blocking)
      try {
        await this.auditLogService.logAction(adminId, "SALES_CHANNEL_CREATE", {
          salesChannelId: newChannel.id,
          name: newChannel.name,
          isDisabled: newChannel.isDisabled,
        });
      } catch (auditErr: any) {
        this.logger.warn("Audit log failed for sales channel creation", {
          err: auditErr,
          salesChannelId: newChannel.id,
        });
      }

      this.logger.info("Sales channel created", {
        salesChannelId: newChannel.id,
        name: newChannel.name,
      });
      return newChannel;
    } catch (err: any) {
      // Map repository duplicate constraint to DomainError (covers race condition)
      const repoErr = err as RepositoryError | undefined;
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "A sales channel with the same unique constraint already exists.",
        );
      }

      // Map common transient errors to internal error with logging
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error("DB connection error while saving sales channel", {
          err,
          name,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving sales channel.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("DB timeout while saving sales channel", {
          err,
          name,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving sales channel.",
        );
      }

      // Fallback: log and wrap unexpected errors
      this.logger.error("Failed to persist sales channel", { err, name });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist sales channel.",
      );
    }
  }
}
