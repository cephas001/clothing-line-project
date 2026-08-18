// apps/api/src/use-cases/logistics/InitiateReturnAuthorizationUseCase.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Order } from "@api/domain/entities/Order";
import { ReturnAuthorization } from "@api/domain/entities/ReturnAuthorization";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IReturnRepository } from "@api/domain/interfaces/repositories/IReturnRepository";
import { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  ProviderShipmentReference,
  ReturnLabelRequest,
  ShipmentParcelItem,
  ShippingOptionSelection,
} from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import {
  toNonNegativeInteger,
  toNonNegativeMinorUnits,
  toPositiveQuantity,
} from "@api/utils/moneyUtils";

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
  /**
   * The RETURN courier + service rate the application selected from the
   * provider's return-rates response. REQUIRED when a return label is
   * requested — the logistics adapter must never independently choose a return
   * courier.
   */
  returnSelection?: ShippingOptionSelection;
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
      toPositiveQuantity(it.quantity, `Item at index ${idx} quantity`);
      if (!it.reasonCode || typeof it.reasonCode !== "string") {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Item at index ${idx} must include a reasonCode.`,
        );
      }
    }

    // --- Validate the return courier selection when a label is requested ----
    // The logistics adapter must never independently choose a return courier;
    // the application supplies the selected return courier + service rate.
    const returnSelection = input.returnSelection;
    if (requireReturnLabel) {
      if (!returnSelection || typeof returnSelection !== "object") {
        throw new DomainError(
          "VALIDATION_ERROR",
          "A return courier selection (returnSelection) is required to create a return label.",
        );
      }
      if (
        typeof (returnSelection.courierId ?? "").trim() !== "string" ||
        !(returnSelection.courierId ?? "").trim() ||
        typeof (returnSelection.serviceCode ?? "").trim() !== "string" ||
        !(returnSelection.serviceCode ?? "").trim()
      ) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "returnSelection must include the return courierId and serviceCode.",
        );
      }
      toNonNegativeMinorUnits(
        returnSelection.amountMinor,
        "returnSelection amountMinor",
      );
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
    let order: Order | null = null;
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

    // Capture the narrowed non-null aggregate for use inside the transaction closure.
    const loadedOrder = order;

    // --- Validate each return item against order state and fulfilled quantities
    let refundTotalMinor = 0;
    try {
      for (const returnReq of items) {
        const originalItem = Array.isArray(loadedOrder.lineItems)
          ? loadedOrder.lineItems.find(
              (i) => String(i.id) === String(returnReq.lineItemId),
            )
          : null;
        if (!originalItem) {
          throw new DomainError(
            "INVALID_RETURN_ITEM",
            `Line item ${returnReq.lineItemId} not found on order.`,
          );
        }

        const fulfilledQty = toNonNegativeInteger(
          originalItem.fulfilledQuantity ?? 0,
          "Fulfilled quantity",
        );
        const requestedQty = toPositiveQuantity(
          returnReq.quantity,
          "Return quantity",
        );

        if (requestedQty > fulfilledQty) {
          throw new DomainError(
            "INVALID_RETURN_QUANTITY",
            `Cannot return more items than were fulfilled for lineItemId ${returnReq.lineItemId}.`,
          );
        }

        // Use order's domain method to compute prorated value (integer minor units)
        const proratedItemValue = loadedOrder.calculateProratedValue(
          originalItem.id,
          requestedQty,
        );

        refundTotalMinor += proratedItemValue;
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
    let returnLabelProviderShipmentId: string | null = null;
    if (requireReturnLabel) {
      // Guard keeps the type narrow; the fail-fast validation above already
      // guarantees returnSelection is present when requireReturnLabel is true.
      if (!returnSelection) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "A return courier selection (returnSelection) is required to create a return label.",
        );
      }
      // The provider starts a return from the ORIGINAL outbound shipment's
      // provider id — never the application orderId. The destination and parcel
      // items come from the order's frozen shipping snapshot.
      const originalShipment = resolveOriginalShipment(loadedOrder);
      if (!originalShipment) {
        this.logger.error(
          "No provider shipment reference available for return label",
          { orderId, actorId, auditId },
        );
        throw new DomainError(
          "INVALID_STATE",
          "The order has no provider shipment reference to create a return label from.",
        );
      }
      const destination = loadedOrder.shippingSnapshot?.destination;
      if (!destination) {
        this.logger.error(
          "Order has no frozen shipping destination for return label",
          { orderId, actorId, auditId },
        );
        throw new DomainError(
          "INVALID_STATE",
          "The order has no frozen shipping destination to create a return label for.",
        );
      }
      const parcelItems = buildReturnParcelItems(loadedOrder, items);
      const returnRequest: ReturnLabelRequest = {
        orderId: loadedOrder.id,
        items: items.map((it) => ({
          lineItemId: it.lineItemId,
          quantity: Number(it.quantity),
        })),
        originalShipment,
        destination,
        parcelItems,
        returnSelection,
      };
      try {
        const result = await this.logisticsService.createReturnLabel(
          returnRequest,
        );
        if (!result || !result.providerShipmentId) {
          this.logger.error(
            "Logistics service returned invalid return label data",
            { orderId, result, actorId, auditId },
          );
          throw new DomainError(
            "EXTERNAL_SERVICE_ERROR",
            "Logistics provider returned invalid return label data.",
          );
        }
        returnLabelUrl = result.url ?? null;
        returnLabelProviderShipmentId = result.providerShipmentId;
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

    // --- Build the return authorization aggregate
    const rmaId = this.idGenerator.generate();
    const nowIso = new Date().toISOString();
    const returnAuthorization = new ReturnAuthorization({
      id: rmaId,
      orderId: loadedOrder.id,
      items: items.map((it) => ({
        lineItemId: it.lineItemId,
        quantity: Number(it.quantity),
        reasonCode: it.reasonCode,
      })),
      refundAmountMinor: refundTotalMinor,
      shippingLabelUrl: returnLabelUrl,
      // The RETURN label's provider shipment id as a first-class identity,
      // distinct from the outbound fulfillment's provider_shipment_id.
      providerShipmentId: returnLabelProviderShipmentId,
      status: "pending_receipt",
      requestedByCustomerId: requestedByCustomerId ?? null,
      createdBy: actorId,
      createdAt: nowIso,
      metadata: {
        logisticsResponse: {
          // Legacy mirror of the return identity for readers that predate the
          // provider_shipment_id column; it lives on this RMA row and never
          // touches the outbound fulfillment's provider reference.
          providerReference: returnLabelProviderShipmentId,
          // The return-rate selection is preserved so the RMA records which
          // return courier/service/rate produced the label.
          ...(returnSelection ? { returnSelection } : {}),
        },
      },
    });

    // --- Persist RMA (transactional)
    try {
      const work = async () => {
        await this.returnRepository.save(returnAuthorization);

        // Mark order lines as having pending returns via the domain method
        for (const it of returnAuthorization.items) {
          loadedOrder.markReturnPending(it.lineItemId, it.quantity);
        }

        await this.orderRepository.save(loadedOrder);
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
          returnLabelProviderShipmentId
        ) {
          await this.logisticsService.cancelReturnLabel(loadedOrder.id, {
            providerShipmentId: returnLabelProviderShipmentId,
          });
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

/**
 * Resolve the PROVIDER shipment identity of the order's outbound shipment.
 * Prefers the first-class `providerShipmentId` on the fulfillment record and
 * falls back to the legacy `metadata.logisticsResponse.providerReference`.
 * Returns null when no provider identity is recorded.
 */
function resolveOriginalShipment(order: Order): ProviderShipmentReference | null {
  const fulfillment = order.fulfillments.find(
    (f) => f && typeof f === "object",
  );
  if (!fulfillment) {
    return null;
  }
  const record = fulfillment as Record<string, unknown>;

  const readString = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  const providerShipmentId =
    readString(record["providerShipmentId"]) ??
    (() => {
      const metadata = record["metadata"];
      if (metadata && typeof metadata === "object") {
        const logisticsResponse = (metadata as Record<string, unknown>)[
          "logisticsResponse"
        ];
        if (logisticsResponse && typeof logisticsResponse === "object") {
          return readString(
            (logisticsResponse as Record<string, unknown>)["providerReference"],
          );
        }
      }
      return null;
    })();

  if (!providerShipmentId) {
    return null;
  }
  return {
    providerShipmentId,
    trackingNumber: readString(record["trackingNumber"]),
  };
}

/**
 * Build the parcel items being returned from the order's frozen shipping
 * snapshot (titles/weights) and the order's frozen line pricing. Each parcel is
 * tied to its line item so quantities and weights reconcile with the provider.
 */
function buildReturnParcelItems(
  order: Order,
  items: Array<{ lineItemId: string; quantity: number; reasonCode: string }>,
): ShipmentParcelItem[] {
  const snapshotParcels = order.shippingSnapshot?.parcelItems ?? [];
  return items.map((it) => {
    const line = order.lineItems.find(
      (li) => String(li.id) === String(it.lineItemId),
    );
    const snapshot = snapshotParcels.find(
      (p) => String(p.lineItemId) === String(it.lineItemId),
    );
    return {
      lineItemId: it.lineItemId,
      title: snapshot?.title ?? `Item ${it.lineItemId}`,
      description: snapshot?.description ?? null,
      quantity: Number(it.quantity),
      unitPriceMinor: line?.unitPriceMinor ?? 0,
      weightKg: snapshot?.weightKg ?? null,
    };
  });
}
