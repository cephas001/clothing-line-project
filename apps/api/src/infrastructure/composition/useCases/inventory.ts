// apps/api/src/infrastructure/composition/useCases/inventory.ts

// Factory for the L9 inventory / sourcing use cases.
//
// Every use case here depends ONLY on repositories + core dependencies (audit,
// id, logger, transaction manager) — there is no external service in the
// sourcing decision (Shipbubble is never consulted) — so all four are ALWAYS
// wired. The deterministic single-origin rule lives in
// domain/shared/sourcing.ts and is shared by DetermineSourcingLocationUseCase
// and ReserveInventoryUseCase.

import { ConfirmInventoryReservationUseCase } from "@api/use-cases/inventory/ConfirmInventoryReservationUseCase";
import { DetermineSourcingLocationUseCase } from "@api/use-cases/inventory/DetermineSourcingLocationUseCase";
import { ReleaseInventoryReservationUseCase } from "@api/use-cases/inventory/ReleaseInventoryReservationUseCase";
import { ReserveInventoryUseCase } from "@api/use-cases/inventory/ReserveInventoryUseCase";
import type { UseCaseDependencies, UseCaseReportBuilder } from "./types";

export interface InventoryUseCases {
  confirmInventoryReservation: ConfirmInventoryReservationUseCase;
  determineSourcingLocation: DetermineSourcingLocationUseCase;
  releaseInventoryReservation: ReleaseInventoryReservationUseCase;
  reserveInventory: ReserveInventoryUseCase;
}

export function buildInventoryUseCases(
  deps: UseCaseDependencies,
  report: UseCaseReportBuilder,
): InventoryUseCases {
  const { auditLogService, idGenerator, logger, transactionManager } = deps;

  const determineSourcingLocation = new DetermineSourcingLocationUseCase(
    deps.inventoryLocationRepository,
    deps.inventoryLevelRepository,
    auditLogService,
    idGenerator,
    logger,
  );
  const reserveInventory = new ReserveInventoryUseCase(
    deps.inventoryLocationRepository,
    deps.inventoryLevelRepository,
    deps.inventoryReservationRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
  );
  const releaseInventoryReservation = new ReleaseInventoryReservationUseCase(
    deps.inventoryLevelRepository,
    deps.inventoryReservationRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
  );
  const confirmInventoryReservation = new ConfirmInventoryReservationUseCase(
    deps.inventoryLevelRepository,
    deps.inventoryReservationRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
  );

  report.wiredUseCases(
    "DetermineSourcingLocationUseCase",
    "ReserveInventoryUseCase",
    "ReleaseInventoryReservationUseCase",
    "ConfirmInventoryReservationUseCase",
  );

  return {
    confirmInventoryReservation,
    determineSourcingLocation,
    releaseInventoryReservation,
    reserveInventory,
  };
}