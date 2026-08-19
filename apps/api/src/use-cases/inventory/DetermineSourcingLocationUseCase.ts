// apps/api/src/use-cases/inventory/DetermineSourcingLocationUseCase.ts
//
// Use case: determine the sourcing location for a product variant (L9).
//
// Responsibilities:
// - Validate inputs (quantity, optional coordinates shape).
// - Load the active sourcing nodes and the variant's per-location levels.
// - Apply the DETERMINISTIC single-origin rule (domain/shared/sourcing.ts):
//   priority ASC (NULLS LAST) -> sufficient available stock -> code ASC -> id
//   ASC. The result never depends on coordinates and never splits across
//   locations (INV-I8).
// - Fail explicitly with INSUFFICIENT_SINGLE_LOCATION_STOCK when no single
//   node can fulfill the request — even when the caller allows split shipments.
// - Map repository failures to DomainError (SOURCING_FAILED).
// - Emit a non-blocking audit log entry recording the decision/outcome.
// - Log structured events and failures for observability.

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IInventoryLevelRepository } from "@api/domain/interfaces/repositories/IInventoryLevelRepository";
import { IInventoryLocationRepository } from "@api/domain/interfaces/repositories/IInventoryLocationRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { selectOptimalFulfillmentLocation } from "@api/domain/shared/sourcing";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Input for sourcing. `customerCoordinates` is accepted for contract
 * compatibility but is NEVER used by the decision rule (INV-I8);
 * `allowSplitAcrossLocations` is accepted but NEVER honored — sourcing is
 * single-origin by construction.
 */
export interface DetermineSourcingLocationInput {
  variantId: string;
  requestedQuantity: number;
  customerCoordinates?: { lat: number; lng: number } | null;
  allowSplitAcrossLocations?: boolean;
  actorId?: string;
}

export class DetermineSourcingLocationUseCase {
  private static readonly MIN_QUANTITY = 1;

  constructor(
    private readonly inventoryLocationRepository: IInventoryLocationRepository,
    private readonly inventoryLevelRepository: IInventoryLevelRepository,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  /**
   * Returns the id of the single optimal location that can fulfill the request,
   * or throws INSUFFICIENT_SINGLE_LOCATION_STOCK when no single active node has
   * enough available stock. The decision is deterministic for the same
   * (locations, levels, quantity) snapshot.
   */
  async execute(input: DetermineSourcingLocationInput): Promise<string> {
    const variantId = (input.variantId ?? "").trim();
    const requestedQuantity = Number(input.requestedQuantity);
    const coords = input.customerCoordinates ?? null;
    const allowSplit = Boolean(input.allowSplitAcrossLocations);
    const actorId = (input.actorId ?? "").trim() || "system";

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

    // --- Load the deterministic decision inputs
    let activeLocations;
    let levels;
    try {
      [activeLocations, levels] = await Promise.all([
        this.inventoryLocationRepository.listActive(),
        this.inventoryLevelRepository.findByVariant(variantId),
      ]);
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to load sourcing inputs", {
        err,
        variantId,
        requestedQuantity,
        actorId,
        auditId,
      });

      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "SOURCING_FAILED",
          "Database connection error while loading sourcing inputs.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "SOURCING_FAILED",
          "Database timeout while loading sourcing inputs.",
        );
      }

      throw new DomainError(
        "SOURCING_FAILED",
        "Failed to determine sourcing location.",
      );
    }

    // --- Deterministic single-origin selection (INV-I8)
    const chosen = selectOptimalFulfillmentLocation(
      activeLocations,
      levels,
      requestedQuantity,
    );

    if (!chosen) {
      this.logger.info(
        "No single location can fulfill the requested quantity",
        { variantId, requestedQuantity, allowSplit, actorId, auditId },
      );

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
        "INSUFFICIENT_SINGLE_LOCATION_STOCK",
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
          chosenLocationId: chosen.id,
          chosenLocationCode: chosen.code,
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
      chosenLocationId: chosen.id,
      chosenLocationCode: chosen.code,
      auditId,
    });

    return chosen.id;
  }
}