// apps/api/src/use-cases/customers/ApproveB2BQuoteUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Quote } from "@api/domain/entities/Quote";
import { IQuoteRepository } from "@api/domain/interfaces/repositories/IQuoteRepository";
import { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import { INotificationOutboxRepository } from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import { NotificationIntent } from "@api/domain/shared/notifications";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { toNonNegativeMinorUnits } from "@api/utils/moneyUtils";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: approve a B2B quote and notify the quote requester.
 *
 * Responsibilities:
 * - Validate inputs and quote state.
 * - Persist approval metadata and map repository errors to DomainError.
 * - Append the quote_approved notification intent to the notification outbox
 *   INSIDE the same transaction as the quote save (L8 PART 3) — the recipient
 *   is the requester's authoritative `customer.email` and the financial value
 *   is the FROZEN `Quote.approvedTotalMinor`, never recomputed.
 * - Emit a non-blocking audit log entry recording the approval.
 * - Log structured events and failures for observability.
 *
 * L8 PART 3 (outbox migration): the approval is durable and delivered
 * asynchronously; a delivery failure can never roll back the approval. The
 * requester resolution is best-effort — a missing/unreadable requester skips
 * the notification but NEVER fails the approval.
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
    private readonly customerRepository: ICustomerRepository,
    private readonly transactionManager: ITransactionManager,
    private readonly notificationOutboxRepository: INotificationOutboxRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: ApproveB2BQuoteInput): Promise<void> {
    const quoteId = (input.quoteId ?? "").trim();
    const adminId = (input.adminId ?? "").trim();
    const approvedTotalMinor = toNonNegativeMinorUnits(
      input.approvedTotalMinor,
      "approvedTotalMinor",
    );
    const actorId = (input.actorId ?? "").trim() || adminId || "system";
    const approvalNote = (input.approvalNote ?? "").trim() || null;

    // --- Validate inputs
    if (!quoteId) {
      throw new DomainError("VALIDATION_ERROR", "quoteId is required.");
    }
    if (!adminId) {
      throw new DomainError("VALIDATION_ERROR", "adminId is required.");
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

    // --- Resolve the notification recipient (best-effort; never fails approval)
    // L8 PART 3: the recipient is the requester's AUTHORITATIVE customer.email
    // resolved from the persisted customer record — never from a request body.
    // A missing/unreadable requester skips the notification; it can never fail
    // the approval.
    let requesterEmail: string | null = null;
    let requesterName: string | null = null;
    try {
      const requester = await this.customerRepository.findById(
        quote.requestedByCustomerId,
      );
      if (requester?.email) {
        requesterEmail = requester.email;
        requesterName =
          [requester.firstName, requester.lastName].filter(Boolean).join(" ") ||
          null;
      } else {
        this.logger.warn(
          "Quote requester not found; approval notification skipped",
          { quoteId, requesterId: quote.requestedByCustomerId },
        );
      }
    } catch (err: unknown) {
      this.logger.warn(
        "Failed to resolve quote requester for approval notification",
        { err, quoteId, requesterId: quote.requestedByCustomerId },
      );
    }

    // --- Apply approval changes + enqueue notification intent (atomic)
    // L8 PART 3: the quote save and the quote_approved outbox append run in ONE
    // transaction. The financial value is the FROZEN `Quote.approvedTotalMinor`
    // written by Quote.approve(...) — never recomputed.
    const nowIso = new Date().toISOString();
    try {
      const work = async () => {
        quote.approve({
          approvedBy: adminId,
          approvedTotalMinor,
          approvedAt: nowIso,
          note: approvalNote,
        });

        await this.quoteRepository.save(quote);

        if (requesterEmail) {
          const approvalIntent: NotificationIntent = {
            type: "quote_approved",
            payload: {
              recipient: { email: requesterEmail, name: requesterName },
              quoteId: quote.id,
              businessUnitId: quote.businessUnitId,
              approvedTotalMinor: quote.approvedTotalMinor ?? approvedTotalMinor,
              currency: null,
              approvedBy: adminId,
              approvedAt: nowIso,
              note: approvalNote,
            },
          };
          await this.notificationOutboxRepository.append(
            this.idGenerator.generate(),
            approvalIntent,
          );
        }
      };

      await this.transactionManager.execute(work);
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
