// apps/api/src/use-cases/logistics/DetermineSourcingLocationUseCase.ts
import { IInventoryLocationService } from "@api/domain/interfaces/services/IInventoryLocationService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: determine the optimal sourcing location for a product variant.
 *
 * Responsibilities:
 * - Validate inputs and normalize coordinates.
 * - Query the inventory location service for the best fulfillment node based on
 *   availability, proximity, and configurable business rules.
 * - Map adapter/service errors to DomainError with clear domain codes.
 * - Emit a non-blocking audit log entry recording the decision and outcome.
 * - Log structured events and failures for observability.
 */
export interface DetermineSourcingLocationInput {
  variantId: string;
  requestedQuantity: number;
  customerCoordinates?: { lat: number; lng: number } | null;
  allowSplitAcrossLocations?: boolean; // If true, caller can accept split shipments
  actorId?: string;
}

export class DetermineSourcingLocationUseCase {
  private static readonly MIN_QUANTITY = 1;

  constructor(
    private readonly inventoryLocationService: IInventoryLocationService,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  /**
   * Returns a single optimal location id when possible.
   * If no single location can fulfill the request and allowSplitAcrossLocations is true,
   * the inventory service may return a special token or null depending on adapter capabilities.
   */
  async execute(input: DetermineSourcingLocationInput): Promise<string> {
    const variantId = (input.variantId ?? "").trim();
    const requestedQuantity = Number(input.requestedQuantity);
    const coords = input.customerCoordinates ?? null;
    const allowSplit = Boolean(input.allowSplitAcrossLocations);
    const actorId = (input.actorId ?? "system").trim() || "system";

    // --- Validate inputs
    if (!variantId) {
      throw new DomainError("VALIDATION_ERROR", "variantId is required.");
    }
    if (
      !Number.isFinite(requestedQuantity) ||
      requestedQuantity < DetermineSourcingLocationUseCase.MIN_QUANTITY
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "requestedQuantity must be a positive integer.",
      );
    }
    if (coords) {
      const lat = Number(coords.lat);
      const lng = Number(coords.lng);
      if (
        !Number.isFinite(lat) ||
        lat < -90 ||
        lat > 90 ||
        !Number.isFinite(lng) ||
        lng < -180 ||
        lng > 180
      ) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "customerCoordinates must be valid latitude/longitude values.",
        );
      }
    }

    const auditId = this.idGenerator.generate();
    const requestedAt = new Date().toISOString();
    this.logger.info("Determining sourcing location", {
      variantId,
      requestedQuantity,
      coords,
      allowSplit,
      actorId,
      auditId,
    });

    // --- Query inventory location service
    let optimalLocationId: { locationId: string; distance: number } | null =
      null;
    try {
      optimalLocationId =
        await this.inventoryLocationService.findOptimalFulfillmentNode(
          variantId,
          requestedQuantity,
          { lat: coords?.lat ?? 0, lng: coords?.lng ?? 0 },
          { allowSplitAcrossLocations: allowSplit },
        );
    } catch (err: any) {
      const svcErr = err as RepositoryError | undefined;
      this.logger.error("Inventory location service failed", {
        err,
        variantId,
        requestedQuantity,
        coords,
        actorId,
        auditId,
      });

      if (svcErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "EXTERNAL_SERVICE_UNAVAILABLE",
          "Inventory location service unavailable.",
        );
      }
      if (svcErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "EXTERNAL_SERVICE_TIMEOUT",
          "Inventory location service timed out.",
        );
      }
      if (svcErr?.code === RepositoryErrorCode.PERMISSION) {
        throw new DomainError(
          "PERMISSION_DENIED",
          "Insufficient permissions to query inventory locations.",
        );
      }

      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to determine sourcing location.",
      );
    }

    // --- Handle no single-location availability
    if (!optimalLocationId) {
      this.logger.info(
        "No single location can fulfill the requested quantity",
        { variantId, requestedQuantity, allowSplit, actorId, auditId },
      );

      // If caller allows split shipments, ask the inventory service for a split plan if supported
      if (
        allowSplit &&
        typeof (this.inventoryLocationService as any)
          .findSplitFulfillmentPlan === "function"
      ) {
        try {
          const plan = await (
            this.inventoryLocationService as any
          ).findSplitFulfillmentPlan(variantId, requestedQuantity, coords);
          // The plan may include a preferred primary location to start fulfillment from
          if (
            plan &&
            typeof plan.primaryLocationId === "string" &&
            plan.primaryLocationId
          ) {
            // Audit and return the primary location id as the chosen sourcing node
            try {
              await this.auditLogService.logAction(
                actorId,
                "SOURCING_LOCATION_DETERMINED_SPLIT",
                {
                  auditId,
                  variantId,
                  requestedQuantity: String(requestedQuantity),
                  primaryLocationId: plan.primaryLocationId,
                  splitPlanSummary: JSON.stringify(plan).slice(0, 1024),
                  allowSplit: String(allowSplit),
                  determinedAt: requestedAt,
                },
              );
            } catch {
              /* swallow audit errors */
            }

            this.logger.info(
              "Selected primary location from split fulfillment plan",
              { variantId, primaryLocationId: plan.primaryLocationId, auditId },
            );
            return plan.primaryLocationId;
          }
        } catch (err: any) {
          this.logger.warn(
            "Failed to obtain split fulfillment plan from inventory service",
            { err, variantId, requestedQuantity, auditId },
          );
          // Fall through to OUT_OF_STOCK below
        }
      }

      // No single location and no split plan available — treat as out of stock
      try {
        await this.auditLogService.logAction(
          actorId,
          "SOURCING_LOCATION_NOT_FOUND",
          {
            auditId,
            variantId,
            requestedQuantity: String(requestedQuantity),
            allowSplit: String(allowSplit),
            determinedAt: requestedAt,
          },
        );
      } catch {
        /* swallow audit errors */
      }

      throw new DomainError(
        "OUT_OF_STOCK",
        "No single location has sufficient stock to fulfill this request.",
      );
    }

    // --- Successful determination: audit and return
    try {
      await this.auditLogService.logAction(
        actorId,
        "SOURCING_LOCATION_DETERMINED",
        {
          auditId,
          variantId,
          requestedQuantity: String(requestedQuantity),
          chosenLocationId: optimalLocationId?.locationId,
          allowSplit: String(allowSplit),
          determinedAt: requestedAt,
        },
      );
    } catch {
      /* swallow audit errors */
    }

    this.logger.info("Sourcing location determined", {
      variantId,
      requestedQuantity,
      chosenLocationId: optimalLocationId?.locationId,
      auditId,
    });

    return optimalLocationId.locationId;
  }
}
