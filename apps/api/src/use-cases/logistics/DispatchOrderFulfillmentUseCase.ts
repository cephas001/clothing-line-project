// apps/api/src/use-cases/logistics/DispatchOrderFulfillmentUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IFulfillmentRepository } from "@api/domain/interfaces/repositories/IFulfillmentRepository";
import { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { Order } from "@api/domain/entities/Order";
import { FulfillmentRecord } from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: dispatch an order for fulfillment by creating a fulfillment record
 * and requesting a shipping label from the logistics provider.
 *
 * Responsibilities:
 * - Validate inputs and order state.
 * - Request a shipping label from the logistics adapter.
 * - Persist a fulfillment record and transition order fulfillment state.
 * - Persist the fulfillment and order update transactionally.
 * - Map adapter/repository errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the dispatch.
 * - Log structured events and failures for observability.
 */
export interface DispatchOrderFulfillmentInput {
  orderId: string;
  actorId?: string;
  preferredCourier?: string | null;
  serviceLevel?: string | null;
}

export class DispatchOrderFulfillmentUseCase {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly fulfillmentRepository: IFulfillmentRepository,
    private readonly logisticsService: ILogisticsService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: DispatchOrderFulfillmentInput): Promise<void> {
    const orderId = (input.orderId ?? "").trim();
    const actorId = (input.actorId ?? "system").trim() || "system";
    const preferredCourier = input.preferredCourier ?? null;
    const serviceLevel = input.serviceLevel ?? null;

    // --- Validate input
    if (!orderId) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }

    this.logger.info("Dispatching order fulfillment started", {
      orderId,
      actorId,
      preferredCourier,
      serviceLevel,
    });

    // --- Load order
    let order: Order | null;
    try {
      order = await this.orderRepository.findById(orderId);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load order for dispatch", {
        err,
        orderId,
        actorId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while loading order.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while loading order.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to load order for dispatch.",
      );
    }

    if (!order) {
      this.logger.info("Order not found for dispatch", { orderId, actorId });
      throw new DomainError("RESOURCE_NOT_FOUND", "Order not found.");
    }

    // --- Validate order state
    const fulfillmentStatus = String(
      order.fulfillmentStatus ?? "",
    ).toLowerCase();
    if (
      fulfillmentStatus !== "unfulfilled" &&
      fulfillmentStatus !== "ready_for_dispatch"
    ) {
      this.logger.info("Order in invalid fulfillment state for dispatch", {
        orderId,
        currentStatus: fulfillmentStatus,
      });
      throw new DomainError(
        "INVALID_STATE",
        "This order is already fulfilled or not ready for dispatch.",
      );
    }

    // --- Request shipping label from logistics provider
    let labelData: {
      labelUrl: string;
      trackingNumber: string;
      courierName?: string;
      courier?: string;
      serviceLevel?: string;
      providerReference?: string | null;
    };
    try {
      labelData = await this.logisticsService.createShippingLabel(order.id, {
        preferredCourier,
        serviceLevel,
      });

      if (!labelData || !labelData.trackingNumber) {
        this.logger.error("Logistics service returned invalid label data", {
          orderId,
          labelData,
        });
        throw new DomainError(
          "EXTERNAL_SERVICE_ERROR",
          "Logistics provider returned invalid label data.",
        );
      }
    } catch (err: unknown) {
      const svcErr = err as RepositoryError | undefined;
      this.logger.error("Failed to create shipping label", {
        err,
        orderId,
        actorId,
      });

      if (svcErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "EXTERNAL_SERVICE_UNAVAILABLE",
          "Logistics provider unavailable.",
        );
      }
      if (svcErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "EXTERNAL_SERVICE_TIMEOUT",
          "Logistics provider timed out while creating shipping label.",
        );
      }
      if (svcErr?.code === RepositoryErrorCode.PERMISSION) {
        throw new DomainError(
          "PERMISSION_DENIED",
          "Insufficient permissions to request shipping label.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to create shipping label.",
      );
    }

    // --- Build fulfillment record
    const fulfillmentId = this.idGenerator.generate();
    const nowIso = new Date().toISOString();
    const fulfillment: FulfillmentRecord = {
      id: fulfillmentId,
      orderId: order.id,
      trackingNumber: labelData.trackingNumber,
      courier: labelData.courierName ?? labelData.courier ?? "UNKNOWN",
      labelUrl: labelData.labelUrl ?? null,
      serviceLevel: serviceLevel ?? labelData.serviceLevel ?? null,
      status: "pending_dispatch",
      createdAt: nowIso,
      metadata: {
        logisticsResponse: {
          providerReference: labelData.providerReference ?? null,
        },
      },
    };

    // --- Persist fulfillment and update order state (transactional)
    try {
      const work = async () => {
        await this.fulfillmentRepository.save(fulfillment);

        // Update order fulfillment status and attach fulfillment reference
        order.addFulfillment(fulfillment);
        order.setFulfillmentStatus("fulfilled", { updatedAt: nowIso });

        await this.orderRepository.save(order);
      };

      await this.transactionManager.execute(work);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist fulfillment or update order", {
        err,
        orderId,
        fulfillmentId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Fulfillment conflict detected; possible duplicate dispatch.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving fulfillment.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving fulfillment.",
        );
      }

      // Attempt best-effort compensation: try to cancel label if logistics adapter supports it
      try {
        if (typeof this.logisticsService.cancelFulfillment === "function") {
          await this.logisticsService.cancelFulfillment(order.id, {
            trackingNumber: labelData.trackingNumber,
          });
        }
      } catch (compErr: unknown) {
        this.logger.warn(
          "Failed to compensate by cancelling logistics label after persistence failure",
          { err: compErr, orderId, fulfillmentId },
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to dispatch order for fulfillment.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "ORDER_DISPATCHED", {
        auditId: this.idGenerator.generate(),
        orderId,
        fulfillmentId,
        trackingNumber: fulfillment.trackingNumber,
        courier: fulfillment.courier,
        serviceLevel: fulfillment.serviceLevel ?? "",
        dispatchedAt: nowIso,
      });
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for order dispatch", {
        err: auditErr,
        orderId,
        fulfillmentId,
      });
    }

    this.logger.info("Order dispatched for fulfillment", {
      orderId,
      fulfillmentId,
      trackingNumber: fulfillment.trackingNumber,
    });
    return;
  }
}
