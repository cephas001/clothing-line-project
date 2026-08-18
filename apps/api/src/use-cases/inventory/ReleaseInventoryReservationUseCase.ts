// apps/api/src/use-cases/inventory/ReleaseInventoryReservationUseCase.ts
//
// Use case: release an order's reserved inventory back to the available pool
// (L9, INV-I6).
//
// Responsibilities:
// - Load the order's reservations and release every HELD (reserved) line in a
//   single ITransactionManager unit (all-or-nothing).
// - Return stock exactly once: the atomic conditional release
//   (reserved - q, available + q WHERE reserved >= q) plus the reservation
//   state machine (`reserved -> released`) are BOTH idempotent — replaying a
//   release finds the row terminal and skips it, so stock is never returned
//   twice.
// - NEVER touches payments/money (INV-I5): releasing inventory is a stock
//   mutation only; the caller decides any refund/charge outcome.
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

export interface ReleaseInventoryReservationInput {
  /** Reservation anchor id (an order id, or a swap id when scope = "swap"). */
  orderId: string;
  scope?: ReservationScope;
  reason?: "payment_failed" | "order_cancelled" | "abandoned_checkout";
  actorId?: string;
}

export interface ReleasedInventoryLine {
  reservationId: string;
  reservationKey: string;
  variantId: string;
  locationId: string;
  quantity: number;
  status: "released";
  /** true when the line was already terminal (idempotent replay). */
  replayed: boolean;
}

export interface ReleaseInventoryReservationResult {
  orderId: string;
  released: ReleasedInventoryLine[];
}

export class ReleaseInventoryReservationUseCase {
  constructor(
    private readonly inventoryLevelRepository: IInventoryLevelRepository,
    private readonly inventoryReservationRepository: IInventoryReservationRepository,
    private readonly transactionManager: ITransactionManager,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(
    input: ReleaseInventoryReservationInput,
  ): Promise<ReleaseInventoryReservationResult> {
    const orderId = (input.orderId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";
    const reason = input.reason ?? "order_cancelled";
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
        "Failed to load reservations for release.",
      );
    }

    const held = reservations.filter((r) => r.isHeld);
    const released: ReleasedInventoryLine[] = [];

    if (held.length === 0) {
      this.logger.info("Nothing to release; all reservations already terminal", {
        orderId,
        actorId,
      });
      return { orderId, released };
    }

    await this.transactionManager.execute(async () => {
      for (const reservation of held) {
        let returned: boolean;
        try {
          returned = await this.inventoryLevelRepository.releaseReserved(
            reservation.locationId,
            reservation.variantId,
            reservation.quantity,
          );
        } catch (err: unknown) {
          throw this.mapRepositoryError(
            err,
            "Failed to release reserved inventory.",
          );
        }

        if (!returned) {
          // The reserved bucket no longer covers the line (already consumed or
          // swept elsewhere). Mark the line terminal so a later release is an
          // idempotent no-op; the CHECKs keep counters non-negative.
          this.logger.warn(
            "Release found no reserved units to return; marking line terminal",
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

        reservation.release();
        await this.inventoryReservationRepository.save(reservation);

        released.push({
          reservationId: reservation.id,
          reservationKey: reservation.reservationKey,
          variantId: reservation.variantId,
          locationId: reservation.locationId,
          quantity: reservation.quantity,
          status: "released",
          replayed: false,
        });
      }
    });

    // --- Audit AFTER the unit commits (best-effort, never secrets)
    for (const line of released) {
      try {
        await this.auditLogService.logAction(
          actorId,
          "INVENTORY_RESERVATION_RELEASED",
          {
            auditId: this.idGenerator.generate(),
            scope,
            orderId,
            reason,
            variantId: line.variantId,
            locationId: line.locationId,
            quantity: String(line.quantity),
            reservationKey: line.reservationKey,
            releasedAt: new Date().toISOString(),
          },
        );
      } catch (auditErr: unknown) {
        this.logger.warn("Audit log failed for inventory release", {
          err: auditErr,
          orderId,
          variantId: line.variantId,
          actorId,
        });
      }
    }

    this.logger.info("Inventory released", {
      orderId,
      actorId,
      reason,
      releasedLines: released.length,
    });

    return { orderId, released };
  }

  private mapRepositoryError(err: unknown, fallback: string): DomainError {
    const repoErr = err as RepositoryError | undefined;
    if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
      return new DomainError(
        "INTERNAL_ERROR",
        "Database connection error while releasing inventory.",
      );
    }
    if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
      return new DomainError(
        "INTERNAL_ERROR",
        "Database timeout while releasing inventory.",
      );
    }
    return new DomainError("INTERNAL_ERROR", fallback);
  }
}