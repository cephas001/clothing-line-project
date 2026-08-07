// apps/api/src/use-cases/logistics/InitiateReturnAuthorizationUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IReturnRepository } from "@api/domain/interfaces/repositories/IReturnRepository";
import { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: initiate a return authorization (RMA) for an order.
 *
 * Responsibilities:
 * - Validate inputs and ensure the order exists and items are returnable.
 * - Calculate prorated refund amounts using order's historical pricing.
 * - Request a reverse shipping label from logistics provider.
 * - Persist the RMA record transactionally.
 * - Map repository/adapter errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the RMA creation.
 * - Log structured events and failures for observability.
 */
export interface InitiateReturnAuthorizationInput {
  orderId: string;
  items: Array<{ lineItemId: string; quantity: number; reasonCode: string }>;
  requestedByCustomerId?: string;
  actorId?: string;
  requireReturnLabel?: boolean;
}

export class InitiateReturnAuthorizationUseCase {
  private static readonly MIN_QUANTITY = 1;
  private static readonly MAX_ITEMS = 100;

  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly returnRepository: IReturnRepository,
    private readonly logisticsService: ILogisticsService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly transactionManager: ITransactionManager,
  ) {}

  async execute(input: InitiateReturnAuthorizationInput): Promise<{
    rmaId: string;
    refundAmountMinor: number;
    returnLabelUrl?: string | null;
  }> {
    const orderId = (input.orderId ?? "").trim();
    const items = Array.isArray(input.items) ? input.items : [];
    const requestedByCustomerId =
      (input.requestedByCustomerId ?? "").trim() || null;
    const actorId =
      (input.actorId ?? requestedByCustomerId ?? "system").trim() || "system";
    const requireReturnLabel = input.requireReturnLabel !== false; // default true

    // --- Validate inputs
    if (!orderId) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }
    if (!items || items.length === 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "At least one item must be specified for return.",
      );
    }
    if (items.length > InitiateReturnAuthorizationUseCase.MAX_ITEMS) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Too many items. Maximum allowed is ${InitiateReturnAuthorizationUseCase.MAX_ITEMS}.`,
      );
    }

    for (const [idx, it] of items.entries()) {
      if (!it || typeof it !== "object") {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Item at index ${idx} is invalid.`,
        );
      }
      if (!it.lineItemId || typeof it.lineItemId !== "string") {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Item at index ${idx} must include a lineItemId.`,
        );
      }
      const qty = Number(it.quantity);
      if (
        !Number.isFinite(qty) ||
        qty < InitiateReturnAuthorizationUseCase.MIN_QUANTITY
      ) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Item at index ${idx} has invalid quantity.`,
        );
      }
      if (!it.reasonCode || typeof it.reasonCode !== "string") {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Item at index ${idx} must include a reasonCode.`,
        );
      }
    }

    const auditId = this.idGenerator.generate();
    const requestedAt = new Date().toISOString();
    this.logger.info("Initiating return authorization", {
      orderId,
      itemCount: items.length,
      actorId,
      auditId,
    });

    // --- Load order
    let order: any;
    try {
      order = await this.orderRepository.findById(orderId);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to fetch order for return authorization", {
        err,
        orderId,
        actorId,
        auditId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while fetching order.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while fetching order.",
        );
      }

      throw new DomainError("INTERNAL_ERROR", "Failed to fetch order.");
    }

    if (!order) {
      this.logger.info("Order not found for return authorization", {
        orderId,
        actorId,
        auditId,
      });
      throw new DomainError("RESOURCE_NOT_FOUND", "Order not found.");
    }

    // --- Validate each return item against order state and fulfilled quantities
    let refundTotalMinor = 0;
    try {
      for (const returnReq of items) {
        const originalItem = Array.isArray(order.lineItems)
          ? order.lineItems.find(
              (i: any) => String(i.id) === String(returnReq.lineItemId),
            )
          : null;
        if (!originalItem) {
          throw new DomainError(
            "INVALID_RETURN_ITEM",
            `Line item ${returnReq.lineItemId} not found on order.`,
          );
        }

        const fulfilledQty = Number(originalItem.fulfilledQuantity ?? 0);
        const requestedQty = Number(returnReq.quantity);

        if (requestedQty > fulfilledQty) {
          throw new DomainError(
            "INVALID_RETURN_QUANTITY",
            `Cannot return more items than were fulfilled for lineItemId ${returnReq.lineItemId}.`,
          );
        }

        // Use order's domain method to compute prorated value
        let proratedItemValue = 0;
        proratedItemValue = Number(
          order.calculateProratedValue(originalItem.id, requestedQty),
        );

        refundTotalMinor += Math.floor(proratedItemValue);
      }
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      this.logger.error("Error while validating return items", {
        err,
        orderId,
        actorId,
        auditId,
      });
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to validate return items.",
      );
    }

    // --- Request return shipping label if required
    let returnLabelUrl: string | null = null;
    let logisticsResponse: any = null;
    if (requireReturnLabel) {
      try {
        logisticsResponse = await this.logisticsService.createReturnLabel(
          order,
          items,
        );
        if (!logisticsResponse || !logisticsResponse.url) {
          this.logger.error(
            "Logistics service returned invalid return label data",
            { orderId, logisticsResponse, actorId, auditId },
          );
          throw new DomainError(
            "EXTERNAL_SERVICE_ERROR",
            "Logistics provider returned invalid return label data.",
          );
        }
        returnLabelUrl = logisticsResponse.url;
      } catch (err: any) {
        const svcErr = err as RepositoryError | undefined;
        this.logger.error("Failed to create return shipping label", {
          err,
          orderId,
          actorId,
          auditId,
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
            "Logistics provider timed out while creating return label.",
          );
        }
        if (svcErr?.code === RepositoryErrorCode.PERMISSION) {
          throw new DomainError(
            "PERMISSION_DENIED",
            "Insufficient permissions to request return label.",
          );
        }

        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to create return shipping label.",
        );
      }
    }

    // --- Build RMA payload
    const rmaId = this.idGenerator.generate();
    const nowIso = new Date().toISOString();
    const rmaPayload: any = {
      id: rmaId,
      orderId: order.id,
      items: items.map((it) => ({
        lineItemId: it.lineItemId,
        quantity: Number(it.quantity),
        reasonCode: it.reasonCode,
      })),
      refundAmountMinor: refundTotalMinor,
      shippingLabelUrl: returnLabelUrl,
      status: "pending_receipt",
      requestedByCustomerId: requestedByCustomerId,
      createdBy: actorId,
      createdAt: nowIso,
      metadata: {
        logisticsResponse: logisticsResponse
          ? { providerReference: logisticsResponse.providerReference ?? null }
          : null,
      },
    };

    // --- Persist RMA (transactional)
    try {
      const work = async () => {
        await this.returnRepository.save(rmaPayload);

        // Mark order lines as having pending returns via the domain method
        for (const it of rmaPayload.items) {
          order.markReturnPending(it.lineItemId, it.quantity);
        }

        await this.orderRepository.save(order);
      };

      await this.transactionManager.execute(work);
    } catch (err: any) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist RMA or update order", {
        err,
        rmaId,
        orderId,
        actorId,
        auditId,
      });

      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        throw new DomainError(
          "INVALID_OPERATION",
          "Return authorization conflict detected; possible duplicate RMA.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while saving return authorization.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while saving return authorization.",
        );
      }

      // Attempt best-effort compensation: cancel return label if logistics adapter supports it
      try {
        if (
          requireReturnLabel &&
          typeof this.logisticsService.cancelReturnLabel === "function" &&
          logisticsResponse?.providerReference
        ) {
          await this.logisticsService.cancelReturnLabel(
            logisticsResponse.providerReference,
          );
        }
      } catch (compErr: any) {
        this.logger.warn(
          "Failed to compensate by cancelling return label after persistence failure",
          { err: compErr, rmaId, orderId, auditId },
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to create return authorization.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(
        actorId,
        "RETURN_AUTHORIZATION_CREATED",
        {
          auditId,
          rmaId,
          orderId,
          refundAmountMinor: String(refundTotalMinor),
          itemCount: String(items.length),
          shippingLabelProvided: String(Boolean(returnLabelUrl)),
          createdAt: nowIso,
        },
      );
    } catch (auditErr: any) {
      this.logger.warn("Audit log failed for return authorization creation", {
        err: auditErr,
        rmaId,
        orderId,
        actorId,
        auditId,
      });
    }

    this.logger.info("Return authorization created", {
      rmaId,
      orderId,
      refundAmountMinor: refundTotalMinor,
      actorId,
      auditId,
    });
    return { rmaId, refundAmountMinor: refundTotalMinor, returnLabelUrl };
  }
}
