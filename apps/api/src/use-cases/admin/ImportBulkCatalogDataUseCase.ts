// apps/api/src/use-cases/admin/ImportBulkCatalogDataUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IQueueService } from "@api/domain/interfaces/services/IQueueService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import { QUEUE_NAMES } from "@api/domain/shared/jobs";

/**
 * Input DTO for importing bulk catalog data.
 * - adminUserId is required for authorization/auditability.
 * - fileUrl must point to an uploaded CSV/JSON file in a storage bucket.
 */
export interface ImportBulkCatalogDataInput {
  adminUserId: string;
  fileUrl: string; // URL of the uploaded CSV/JSON in a storage bucket (e.g., AWS S3)
  fileType?: "csv" | "json"; // optional hint; validated when present
}

/**
 * Use case: enqueue a background job to import bulk catalog data.
 *
 * Production responsibilities:
 * - Validate inputs (presence, URL shape, optional file type).
 * - Generate a stable job id for tracing.
 * - Enqueue a job payload to the queue service.
 * - Map queue/repository errors to DomainError with stable codes.
 * - Emit a non-blocking audit log entry recording the admin action.
 * - Log important events and failures via injected logger.
 */
export class ImportBulkCatalogDataUseCase {
  constructor(
    private queueService: IQueueService,
    private auditLogService: IAuditLogService,
    private idGenerator: IIdGenerator,
    private logger: ILogger,
  ) {}

  /**
   * Enqueue a bulk import job and return the job id for tracking.
   */
  async execute(input: ImportBulkCatalogDataInput): Promise<{ jobId: string }> {
    // --- Normalize and validate inputs
    const adminUserId = (input.adminUserId ?? "").trim();
    const fileUrlRaw = (input.fileUrl ?? "").trim();
    const fileTypeHint = input.fileType;

    if (!adminUserId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "adminUserId is required for audit logging.",
      );
    }

    if (!fileUrlRaw) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "A valid file URL must be provided for bulk import.",
      );
    }

    // Validate URL shape
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(fileUrlRaw);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Unsupported protocol");
      }
    } catch {
      throw new DomainError(
        "VALIDATION_ERROR",
        "fileUrl must be a valid HTTP or HTTPS URL.",
      );
    }

    // Optional: validate file extension against hint or allowed types
    if (fileTypeHint) {
      if (!["csv", "json"].includes(fileTypeHint)) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "fileType must be 'csv' or 'json' when provided.",
        );
      }
      const ext = parsedUrl.pathname.split(".").pop()?.toLowerCase() ?? "";
      if (ext && ext !== fileTypeHint) {
        // Not fatal — warn and continue, but prefer strictness in production
        this.logger.warn("fileType hint does not match file extension", {
          fileTypeHint,
          ext,
          fileUrl: fileUrlRaw,
        });
      }
    }

    // --- Prepare job payload and id
    const jobId = this.idGenerator.generate();
    const payload = {
      jobId,
      adminUserId,
      fileUrl: fileUrlRaw,
      fileType: fileTypeHint ?? null,
      enqueuedAt: new Date().toISOString(),
    };

    // --- Enqueue job
    try {
      // queueService.enqueueJob may throw repository/queue-specific errors;
      // map them to DomainError below.
      await this.queueService.enqueueJob(QUEUE_NAMES.bulkCatalogImport, payload);
    } catch (err: any) {
      // If the queue layer exposes RepositoryError-like codes, handle common cases
      const repoErr = err as RepositoryError | undefined;

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        this.logger.error(
          "Queue connection error while enqueuing bulk import job",
          { err, jobId, fileUrl: fileUrlRaw },
        );
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue connection error while scheduling bulk import.",
        );
      }

      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        this.logger.error("Queue timeout while enqueuing bulk import job", {
          err,
          jobId,
          fileUrl: fileUrlRaw,
        });
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue timeout while scheduling bulk import.",
        );
      }

      // Generic fallback for other queue errors
      this.logger.error("Failed to enqueue bulk import job", {
        err,
        jobId,
        fileUrl: fileUrlRaw,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to schedule bulk import job.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        adminUserId,
        "BULK_CATALOG_IMPORT_ENQUEUED",
        {
          jobId,
          fileUrl: fileUrlRaw,
          fileType: fileTypeHint ?? "unknown",
        },
      );
    } catch (auditErr: any) {
      // Audit failures should not block the main flow; log and continue
      this.logger.warn("Audit log failed for bulk catalog import enqueue", {
        err: auditErr,
        jobId,
        adminUserId,
      });
    }

    this.logger.info("Bulk catalog import job enqueued", {
      jobId,
      fileUrl: fileUrlRaw,
      adminUserId,
    });
    return { jobId };
  }
}
