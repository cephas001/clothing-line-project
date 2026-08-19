// apps/api/src/use-cases/inventory/ConfirmInventoryReservationUseCase.ts
//
// Use case: confirm an order's reserved inventory at fulfillment time (L9,
// INV-I7).
//
// Responsibilities:
// - Load the order's reservations and confirm every HELD (reserved) line in a
//   single ITransactionManager unit (all-or-nothing).
// - Consume held units exactly once: the atomic conditional confirm
//   (reserved - q WHERE reserved >= q) plus the reservation state machine
//   (`reserved -> confirmed`) are BOTH idempotent — replaying a confirmation
//   finds the row terminal and skips it, so units are never consumed twice.
// - NEVER touches payments/money (INV-I5): confirming inventory is a stock
//   mutation only.
// - Emit a non-blocking audit log entry AFTER the unit commits.
// - Log structured events and failures for observability.

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { InventoryReservation } from "@api/domain/entities/InventoryReservation";
import { IInventoryLevelRepository } from "@api/domain/interfaces/repositories/IInventoryLevelRepository";
import { IInventoryReservationRepository } from "@api/domain/interfaces/repositories/IInventoryReservationRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import type { ReservationScope } from "@api/domain/shared/inventoryReservationKey";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface ConfirmInventoryReservationInput {
  /** Reservation anchor id (an order id, or a swap id when scope = "swap"). */
  orderId: string;
  /** Reservation scope; defaults to "order". */
  scope?: ReservationScope;
  actorId?: string;
}

export interface ConfirmedInventoryLine {
  reservationId: string;
  reservationKey: string;
  variantId: string;
  locationId: string;
  quantity: number;
  status: "confirmed";
  /** true when the line was already terminal (idempotent replay). */
  replayed: boolean;
}

export interface ConfirmInventoryReservationResult {
  orderId: string;
  confirmed: ConfirmedInventoryLine[];
}

export class ConfirmInventoryReservationUseCase {
  constructor(
    private readonly inventoryLevelRepository: IInventoryLevelRepository,
    private readonly inventoryReservationRepository: IInventoryReservationRepository,
    private readonly transactionManager: ITransactionManager,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(
    input: ConfirmInventoryReservationInput,
  ): Promise<ConfirmInventoryReservationResult> {
    const orderId = (input.orderId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";
    const scope: ReservationScope = input.scope === "swap" ? "swap" : "order";

    if (!orderId) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }

    let reservations: InventoryReservation[];
    try {
      reservations = await this.inventoryReservationRepository.findByOrder(
        orderId,
      );
    } catch (err: unknown) {
      throw this.mapRepositoryError(
        err,
        "Failed to load reservations for confirmation.",
      );
    }

    const held = reservations.filter((r) => r.isHeld);
    const confirmed: ConfirmedInventoryLine[] = [];

    if (held.length === 0) {
      this.logger.info("Nothing to confirm; all reservations already terminal", {
        orderId,
        actorId,
      });
      return { orderId, confirmed };
    }

    await this.transactionManager.execute(async () => {
      for (const reservation of held) {
        let consumed: boolean;
        try {
          consumed = await this.inventoryLevelRepository.confirmReserved(
            reservation.locationId,
            reservation.variantId,
            reservation.quantity,
          );
        } catch (err: unknown) {
          throw this.mapRepositoryError(
            err,
            "Failed to confirm reserved inventory.",
          );
        }

        if (!consumed) {
          // The reserved bucket no longer covers the line (already consumed
          // elsewhere). Mark the line terminal so a later confirm is an
          // idempotent no-op; the CHECKs keep counters non-negative.
          this.logger.warn(
            "Confirm found no reserved units to consume; marking line terminal",
            {
              orderId,
              reservationId: reservation.id,
              variantId: reservation.variantId,
              locationId: reservation.locationId,
              quantity: reservation.quantity,
              actorId,
            },
          );
        }

        reservation.confirm();
        await this.inventoryReservationRepository.save(reservation);

        confirmed.push({
          reservationId: reservation.id,
          reservationKey: reservation.reservationKey,
          variantId: reservation.variantId,
          locationId: reservation.locationId,
          quantity: reservation.quantity,
          status: "confirmed",
          replayed: false,
        });
      }
    });

    // --- Audit AFTER the unit commits (best-effort, never secrets)
    for (const line of confirmed) {
      try {
        await this.auditLogService.logAction(
          actorId,
          "INVENTORY_RESERVATION_CONFIRMED",
          {
            auditId: this.idGenerator.generate(),
            scope,
            orderId,
            variantId: line.variantId,
            locationId: line.locationId,
            quantity: String(line.quantity),
            reservationKey: line.reservationKey,
            confirmedAt: new Date().toISOString(),
          },
        );
      } catch (auditErr: unknown) {
        this.logger.warn("Audit log failed for inventory confirmation", {
          err: auditErr,
          orderId,
          variantId: line.variantId,
          actorId,
        });
      }
    }

    this.logger.info("Inventory reserved units confirmed", {
      orderId,
      actorId,
      confirmedLines: confirmed.length,
    });

    return { orderId, confirmed };
  }

  private mapRepositoryError(err: unknown, fallback: string): DomainError {
    const repoErr = err as RepositoryError | undefined;
    if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
      return new DomainError(
        "INTERNAL_ERROR",
        "Database connection error while confirming inventory.",
      );
    }
    if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
      return new DomainError(
        "INTERNAL_ERROR",
        "Database timeout while confirming inventory.",
      );
    }
    return new DomainError("INTERNAL_ERROR", fallback);
  }
}