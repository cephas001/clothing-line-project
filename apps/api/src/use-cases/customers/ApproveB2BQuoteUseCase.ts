// apps/api/src/use-cases/customers/ApproveB2BQuoteUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Quote } from "@api/domain/entities/Quote";
import { IQuoteRepository } from "@api/domain/interfaces/repositories/IQuoteRepository";
import { INotificationService } from "@api/domain/interfaces/services/INotificationService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: approve a B2B quote and notify the requesting business unit.
 *
 * Responsibilities:
 * - Validate inputs and quote state.
 * - Persist approval metadata and map repository errors to DomainError.
 * - Notify the business unit via the notification service (best-effort).
 * - Emit a non-blocking audit log entry recording the approval.
 * - Log structured events and failures for observability.
 */
export interface ApproveB2BQuoteInput {
  quoteId: string;
  adminId: string;
  approvedTotalMinor: number;
  actorId?: string;
  approvalNote?: string;
}

export class ApproveB2BQuoteUseCase {
  constructor(
    private readonly quoteRepository: IQuoteRepository,
    private readonly notificationService: INotificationService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: ApproveB2BQuoteInput): Promise<void> {
    const quoteId = (input.quoteId ?? "").trim();
    const adminId = (input.adminId ?? "").trim();
    const approvedTotalMinor = Number(input.approvedTotalMinor);
    const actorId = (input.actorId ?? "").trim() || adminId || "system";
    const approvalNote = (input.approvalNote ?? "").trim() || null;

    // --- Validate inputs
    if (!quoteId) {
      throw new DomainError("VALIDATION_ERROR", "quoteId is required.");
    }
    if (!adminId) {
      throw new DomainError("VALIDATION_ERROR", "adminId is required.");
    }
    if (!Number.isFinite(approvedTotalMinor) || approvedTotalMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "approvedTotalMinor must be a non-negative number.",
      );
    }

    // --- Load quote
    let quote: Quote | null;
    try {
      quote = await this.quoteRepository.findById(quoteId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load quote for approval", { err, quoteId });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while loading quote.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while loading quote.",
        );
      }
      throw new DomainError("INTERNAL_ERROR", "Failed to load quote.");
    }

    if (!quote) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Quote not found.");
    }

    // --- Validate quote state
    if (quote.status !== "PENDING_APPROVAL") {
      this.logger.info("Attempt to approve quote in invalid state", {
        quoteId,
        currentStatus: quote.status,
      });
      throw new DomainError("INVALID_STATE", "Quote is not pending approval.");
    }

    // --- Apply approval changes
    const nowIso = new Date().toISOString();
    try {
      quote.approve({
        approvedBy: adminId,
        approvedTotalMinor,
        approvedAt: nowIso,
        note: approvalNote,
      });

      await this.quoteRepository.save(quote);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist quote approval", {
        err,
        quoteId,
        adminId,
        approvedTotalMinor,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Quote approval conflict detected.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving quote approval.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving quote approval.",
        );
      }

      throw new DomainError("INTERNAL_ERROR", "Failed to approve quote.");
    }

    // --- Notify business unit (best-effort)
    try {
      // Provide minimal payload to avoid leaking sensitive data
      await this.notificationService.notifyQuoteApproved(
        quote.businessUnitId,
        quote.id,
        {
          approvedBy: adminId,
          approvedTotalMinor,
          approvedAt: nowIso,
          note: approvalNote,
        },
      );
    } catch (err: unknown) {
      this.logger.warn(
        "Notification service failed to notify business unit about approved quote",
        { err, quoteId, businessUnitId: quote.businessUnitId },
      );
      // Do not fail the approval if notification fails; record in audit log below
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "QUOTE_APPROVED", {
        auditId: this.idGenerator.generate(),
        quoteId,
        businessUnitId: quote.businessUnitId,
        approvedBy: adminId,
        approvedTotalMinor: String(approvedTotalMinor),
        approvalNote: approvalNote ?? "",
        approvedAt: nowIso,
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for quote approval", {
        err: auditErr,
        quoteId,
      });
    }

    this.logger.info("Quote approved", {
      quoteId,
      businessUnitId: quote.businessUnitId,
      approvedBy: adminId,
      approvedTotalMinor,
    });
    return;
  }
}
