// apps/api/src/use-cases/logistics/ProcessCourierTrackingEventUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IFulfillmentRepository } from "@api/domain/interfaces/repositories/IFulfillmentRepository";
import { INotificationService } from "@api/domain/interfaces/services/INotificationService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface ProcessCourierTrackingEventInput {
  trackingNumber: string;
  courierStatus:
    | "in_transit"
    | "out_for_delivery"
    | "delivered"
    | "failed_attempt"
    | string;
  timestamp: Date | string;
  actorId?: string;
  notifyCustomer?: boolean;
}

export class ProcessCourierTrackingEventUseCase {
  constructor(
    private readonly fulfillmentRepository: IFulfillmentRepository,
    private readonly notificationService: INotificationService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  /**
   * Process an incoming courier tracking event.
   * - Safely ignore unknown tracking numbers.
   * - Normalize courier status and timestamp.
   * - Persist fulfillment status updates and emit notifications (best-effort).
   * - Record an audit entry (non-blocking).
   */
  async execute(input: ProcessCourierTrackingEventInput): Promise<void> {
    const trackingNumber = (input.trackingNumber ?? "").trim();
    const rawStatus = (input.courierStatus ?? "").toString().trim();
    const actorId = (input.actorId ?? "system").trim() || "system";
    const notifyCustomer = Boolean(input.notifyCustomer ?? true);

    if (!trackingNumber) {
      throw new DomainError("VALIDATION_ERROR", "trackingNumber is required.");
    }

    // Normalize timestamp
    let eventTimestamp: Date;
    try {
      eventTimestamp =
        input.timestamp instanceof Date
          ? input.timestamp
          : new Date(String(input.timestamp));
      if (Number.isNaN(eventTimestamp.getTime()))
        throw new Error("Invalid date");
    } catch {
      throw new DomainError(
        "VALIDATION_ERROR",
        "timestamp must be a valid Date or ISO string.",
      );
    }

    // Map incoming courier statuses to internal fulfillment statuses
    const statusMap: Record<string, string> = {
      in_transit: "in_transit",
      out_for_delivery: "out_for_delivery",
      delivered: "delivered",
      failed_attempt: "delivery_failed",
    };

    const normalizedStatus = statusMap[rawStatus] ?? rawStatus;

    const auditId = this.idGenerator.generate();
    const processedAt = new Date().toISOString();

    this.logger.info("Processing courier tracking event", {
      trackingNumber,
      rawStatus,
      normalizedStatus,
      eventTimestamp: eventTimestamp.toISOString(),
      actorId,
      auditId,
    });

    // --- Load fulfillment by tracking number
    let fulfillment: any | null = null;
    try {
      fulfillment =
        await this.fulfillmentRepository.findByTrackingNumber(trackingNumber);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to query fulfillment by tracking number", {
        err,
        trackingNumber,
        auditId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while processing tracking event.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while processing tracking event.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to process tracking event.",
      );
    }

    // Unknown tracking numbers are safe to ignore (webhooks from couriers can be noisy)
    if (!fulfillment) {
      try {
        await this.auditLogService.logAction(
          actorId,
          "TRACKING_EVENT_IGNORED_UNKNOWN",
          {
            auditId,
            trackingNumber,
            rawStatus,
            eventTimestamp: eventTimestamp.toISOString(),
            processedAt,
          },
        );
      } catch {
        /* swallow audit errors */
      }

      this.logger.info("Ignoring tracking event for unknown tracking number", {
        trackingNumber,
        rawStatus,
        auditId,
      });
      return;
    }

    // --- Determine whether the incoming status represents a meaningful state change
    const previousStatus = (fulfillment.status ?? "").toString();
    const previousUpdatedAt = fulfillment.updatedAt
      ? new Date(fulfillment.updatedAt).getTime()
      : 0;
    const incomingTs = eventTimestamp.getTime();

    // If the event is older than the stored update, ignore to avoid regressions
    if (previousUpdatedAt && incomingTs <= previousUpdatedAt) {
      try {
        await this.auditLogService.logAction(
          actorId,
          "TRACKING_EVENT_IGNORED_OLD",
          {
            auditId,
            fulfillmentId: fulfillment.id,
            trackingNumber,
            previousStatus,
            incomingStatus: normalizedStatus,
            previousUpdatedAt: new Date(previousUpdatedAt).toISOString(),
            incomingAt: eventTimestamp.toISOString(),
            processedAt,
          },
        );
      } catch {
        /* swallow audit errors */
      }

      this.logger.info("Ignoring out-of-order tracking event", {
        fulfillmentId: fulfillment.id,
        trackingNumber,
        previousUpdatedAt,
        incomingAt: eventTimestamp.toISOString(),
        auditId,
      });
      return;
    }

    // --- Apply update to fulfillment entity
    try {
      // Use domain method if available
      if (typeof fulfillment.updateStatus === "function") {
        fulfillment.updateStatus(normalizedStatus, {
          updatedAt: eventTimestamp.toISOString(),
        });
      } else {
        fulfillment.status = normalizedStatus;
        fulfillment.updatedAt = eventTimestamp.toISOString();
      }

      // Persist the change
      await this.fulfillmentRepository.save(fulfillment);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist fulfillment status update", {
        err,
        fulfillmentId: fulfillment.id,
        trackingNumber,
        auditId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while updating fulfillment status.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while updating fulfillment status.",
        );
      }

      // Best-effort: attempt to record audit of failure, then rethrow generic domain error
      try {
        await this.auditLogService.logAction(
          actorId,
          "TRACKING_EVENT_PERSIST_FAILED",
          {
            auditId,
            fulfillmentId: fulfillment.id,
            trackingNumber,
            attemptedStatus: normalizedStatus,
            eventTimestamp: eventTimestamp.toISOString(),
            processedAt,
          },
        );
      } catch {
        /* swallow audit errors */
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist tracking update.",
      );
    }

    // --- Notify customer (best-effort)
    if (notifyCustomer) {
      try {
        // Provide minimal payload to notification service
        await this.notificationService.sendTrackingUpdate(
          fulfillment.orderId,
          normalizedStatus,
          {
            trackingNumber,
            courier: fulfillment.courier ?? undefined,
            occurredAt: eventTimestamp.toISOString(),
          },
        );
      } catch (err: any) {
        this.logger.warn(
          "Notification service failed to send tracking update",
          { err, fulfillmentId: fulfillment.id, trackingNumber, auditId },
        );
        // Do not fail the flow if notification fails
      }
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId,
        "TRACKING_EVENT_PROCESSED",
        {
          auditId,
          fulfillmentId: fulfillment.id,
          orderId: fulfillment.orderId,
          trackingNumber,
          previousStatus,
          newStatus: normalizedStatus,
          eventTimestamp: eventTimestamp.toISOString(),
          processedAt,
        },
      );
    } catch {
      /* swallow audit errors */
    }

    this.logger.info("Processed courier tracking event", {
      fulfillmentId: fulfillment.id,
      orderId: fulfillment.orderId,
      trackingNumber,
      previousStatus,
      newStatus: normalizedStatus,
      auditId,
    });

    return;
  }
}
