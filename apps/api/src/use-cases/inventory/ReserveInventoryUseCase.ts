// apps/api/src/use-cases/inventory/ReserveInventoryUseCase.ts
//
// Use case: durably reserve inventory for an order (L9, INV-I1..INV-I7).
//
// Responsibilities:
// - Validate and aggregate order line items (per-variant quantities summed,
//   processed in deterministic variantId order).
// - Source each variant deterministically (single-origin, INV-I8) unless a
//   prior reservation already pinned its location — a retry NEVER re-sources
//   to a different node (that would double-consume).
// - Reserve atomically: one ITransactionManager unit per batch, where each
//   line is an atomic conditional level UPDATE (available - q, reserved + q
//   WHERE available >= q) + a reservation insert inside the SAME unit.
// - Enforce durable idempotency via the deterministic reservation_key
//   (INV-I3/INV-I4): a retried/concurrent duplicate collides on
//   UNIQUE(reservation_key) and the loser's whole unit rolls back (decrement
//   undone); the winner's committed row is then replayed exactly once.
// - Reject a retry whose per-variant quantity differs from the committed row
//   (an identical request replays; a changed request must release first).
// - NEVER touches payments/money (INV-I5): inventory failure is surfaced to
//   the caller, which decides the checkout outcome — inventory code never
//   initiates or retries a charge.
// - Emit a non-blocking audit log entry AFTER the unit commits (INV-audit).
// - Log structured events and failures for observability.

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { InventoryLocation } from "@api/domain/entities/InventoryLocation";
import { InventoryLevel } from "@api/domain/entities/InventoryLevel";
import { InventoryReservation } from "@api/domain/entities/InventoryReservation";
import { IInventoryLevelRepository } from "@api/domain/interfaces/repositories/IInventoryLevelRepository";
import { IInventoryLocationRepository } from "@api/domain/interfaces/repositories/IInventoryLocationRepository";
import { IInventoryReservationRepository } from "@api/domain/interfaces/repositories/IInventoryReservationRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { selectOptimalFulfillmentLocation } from "@api/domain/shared/sourcing";
import {
  buildReservationKey,
  buildSwapReservationKey,
  ReservationScope,
} from "@api/domain/shared/inventoryReservationKey";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/** Raised inside the transaction when a concurrent duplicate owns the key. */
class ConcurrentReservationError extends Error {
  constructor(readonly reservationKey: string) {
    super(`Concurrent reservation exists for key ${reservationKey}.`);
    this.name = "ConcurrentReservationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ReserveInventoryItem {
  variantId: string;
  quantity: number;
}

export interface ReserveInventoryInput {
  /**
   * The reservation anchor id. For `scope: "order"` (default) this is an order
   * id (or the checkout payment reference that anchors a checkout hold); for
   * `scope: "swap"` it is the DETERMINISTIC swap id resolved via the swap's
   * natural key, so a re-run of the same swap request replays the SAME hold.
   */
  orderId: string;
  /** Reservation scope; defaults to "order". Swap holds key on a `swap:` prefix. */
  scope?: ReservationScope;
  items: ReserveInventoryItem[];
  /** Optional hold expiry (ISO timestamp); swept by a future expiry job. */
  expiresAt?: string | null;
  actorId?: string;
}

export interface ReservedInventoryLine {
  reservationId: string;
  reservationKey: string;
  variantId: string;
  locationId: string;
  quantity: number;
  status: "reserved" | "confirmed";
  /** true when this line was already reserved by a prior identical attempt. */
  replayed: boolean;
}

export interface ReserveInventoryResult {
  orderId: string;
  reservations: ReservedInventoryLine[];
}

export class ReserveInventoryUseCase {
  private static readonly MAX_REQUEST_QTY = 10_000;
  private static readonly MAX_BATCH_ATTEMPTS = 3;

  constructor(
    private readonly inventoryLocationRepository: IInventoryLocationRepository,
    private readonly inventoryLevelRepository: IInventoryLevelRepository,
    private readonly inventoryReservationRepository: IInventoryReservationRepository,
    private readonly transactionManager: ITransactionManager,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
  ) {}

  async execute(input: ReserveInventoryInput): Promise<ReserveInventoryResult> {
    const orderId = (input.orderId ?? "").trim();
    const actorId = (input.actorId ?? "").trim() || "system";
    const expiresAt = (input.expiresAt ?? "").trim() || null;
    const scope: ReservationScope = input.scope === "swap" ? "swap" : "order";

    // --- Validate + aggregate inputs
    if (!orderId) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "items must contain at least one variant line.",
      );
    }

    const items = this.aggregateItems(input.items);
    const pending = items.slice();
    const reservations: ReservedInventoryLine[] = [];
    const orderedLines = new Set<string>();

    let existingByOrder: InventoryReservation[];
    try {
      existingByOrder = await this.inventoryReservationRepository.findByOrder(
        orderId,
      );
    } catch (err: unknown) {
      throw this.mapRepositoryError(
        err,
        "Failed to load existing reservations.",
      );
    }

    // --- Reserve in bounded batches; resolve concurrent duplicates by replay
    for (
      let attempt = 0;
      attempt < ReserveInventoryUseCase.MAX_BATCH_ATTEMPTS &&
      pending.length > 0;
      attempt++
    ) {
      let conflictKey: string | null = null;
      try {
        const batch = await this.reserveBatch(
          orderId,
          actorId,
          expiresAt,
          scope,
          pending,
          existingByOrder,
        );
        for (const line of batch) {
          if (!orderedLines.has(line.reservationKey)) {
            reservations.push(line);
            orderedLines.add(line.reservationKey);
          }
        }
        // The batch committed: every line in it (reserved or replayed) is now
        // durably held, so drop those variants from the pending work.
        const handled = new Set(batch.map((line) => line.variantId));
        const remaining = pending.filter((i) => !handled.has(i.variantId));
        pending.length = 0;
        pending.push(...remaining);
      } catch (err: unknown) {
        if (err instanceof ConcurrentReservationError) {
          conflictKey = err.reservationKey;
        } else {
          throw err;
        }
      }

      if (conflictKey) {
        // The winner committed; refresh and replay its row exactly once.
        try {
          existingByOrder =
            await this.inventoryReservationRepository.findByOrder(orderId);
        } catch (err: unknown) {
          throw this.mapRepositoryError(
            err,
            "Failed to reload reservations after a concurrent conflict.",
          );
        }
        const winner = await this.inventoryReservationRepository.findByKey(
          conflictKey,
        );
        if (!winner || !(winner.isHeld || winner.status === "confirmed")) {
          throw new DomainError(
            "INVALID_OPERATION",
            "Concurrent reservation conflict could not be resolved.",
          );
        }
        const item = pending.find(
          (i) => i.variantId === winner.variantId,
        );
        if (item && item.quantity !== winner.quantity) {
          throw new DomainError(
            "INVALID_OPERATION",
            `Concurrent reservation for variant ${winner.variantId} already holds ${winner.quantity} units (requested ${item.quantity}); identical retries replay, changed requests must be released first.`,
          );
        }
        reservations.push({
          reservationId: winner.id,
          reservationKey: winner.reservationKey,
          variantId: winner.variantId,
          locationId: winner.locationId,
          quantity: winner.quantity,
          status: winner.status as "reserved" | "confirmed",
          replayed: true,
        });
        orderedLines.add(winner.reservationKey);
        const rest = pending.filter(
          (i) => i.variantId !== winner.variantId,
        );
        pending.length = 0;
        pending.push(...rest);
      }
    }

    if (pending.length > 0) {
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to reserve inventory after bounded retries.",
      );
    }

    // --- Audit AFTER the units commit (best-effort, never secrets)
    for (const line of reservations) {
      if (line.replayed) {
        continue;
      }
      try {
        await this.auditLogService.logAction(
          actorId,
          "INVENTORY_RESERVED",
          {
            auditId: this.idGenerator.generate(),
            scope,
            orderId,
            variantId: line.variantId,
            locationId: line.locationId,
            quantity: String(line.quantity),
            reservationKey: line.reservationKey,
            reservedAt: new Date().toISOString(),
          },
        );
      } catch (auditErr: unknown) {
        this.logger.warn("Audit log failed for inventory reservation", {
          err: auditErr,
          orderId,
          variantId: line.variantId,
          actorId,
        });
      }
    }

    this.logger.info("Inventory reserved", {
      orderId,
      actorId,
      reservedLines: reservations.length,
    });

    return { orderId, reservations };
  }

  /**
   * Reserve one batch inside a SINGLE transaction. Returns the resulting lines
   * or throws ConcurrentReservationError when a concurrent duplicate owns a
   * key — the whole unit (including every level decrement) rolls back.
   */
  private async reserveBatch(
    orderId: string,
    actorId: string,
    expiresAt: string | null,
    scope: ReservationScope,
    items: ReserveInventoryItem[],
    existingByOrder: InventoryReservation[],
  ): Promise<ReservedInventoryLine[]> {
    const plans = this.planReservations(
      orderId,
      items,
      existingByOrder,
      actorId,
    );

    // Fresh lines need the deterministic single-origin decision. Load active
    // nodes once; a variant with no existing reservation always sources here.
    if (plans.some((p) => p.mode === "fresh")) {
      let activeLocations: InventoryLocation[];
      try {
        activeLocations =
          await this.inventoryLocationRepository.listActive();
      } catch (err: unknown) {
        throw this.mapRepositoryError(
          err,
          "Failed to load active inventory locations.",
        );
      }

      for (const plan of plans) {
        if (plan.mode !== "fresh") {
          continue;
        }
        let levels: InventoryLevel[];
        try {
          levels = await this.inventoryLevelRepository.findByVariant(
            plan.item.variantId,
          );
        } catch (err: unknown) {
          throw this.mapRepositoryError(
            err,
            "Failed to load inventory levels.",
          );
        }
        const chosen = selectOptimalFulfillmentLocation(
          activeLocations,
          levels,
          plan.item.quantity,
        );
        if (!chosen) {
          throw new DomainError(
            "INSUFFICIENT_SINGLE_LOCATION_STOCK",
            `No single location has sufficient stock for variant ${plan.item.variantId} (${plan.item.quantity}).`,
          );
        }
        plan.locationId = chosen.id;
      }
    }

    const lines: ReservedInventoryLine[] = [];

    await this.transactionManager.execute(async () => {
      for (const plan of plans) {
        if (plan.mode === "replay") {
          lines.push(plan.replayLine!);
          continue;
        }

        const key =
          scope === "swap"
            ? buildSwapReservationKey(
                orderId,
                plan.item.variantId,
                plan.locationId!,
              )
            : buildReservationKey(
                orderId,
                plan.item.variantId,
                plan.locationId!,
              );

        // Authoritative in-transaction check: covers the window between the
        // pre-transaction findByOrder and this unit.
        let row: InventoryReservation | null = null;
        try {
          row = await this.inventoryReservationRepository.findByKey(key);
        } catch (err: unknown) {
          throw this.mapRepositoryError(
            err,
            "Failed to re-check reservation key.",
          );
        }
        if (row && (row.isHeld || row.status === "confirmed")) {
          if (row.quantity !== plan.item.quantity) {
            throw new DomainError(
              "INVALID_OPERATION",
              `A reservation already exists for order ${orderId} variant ${plan.item.variantId} with quantity ${row.quantity}; retries must match the original request.`,
            );
          }
          lines.push({
            reservationId: row.id,
            reservationKey: row.reservationKey,
            variantId: row.variantId,
            locationId: row.locationId,
            quantity: row.quantity,
            status: row.status as "reserved" | "confirmed",
            replayed: true,
          });
          continue;
        }

        // Reactivation target: the terminal row found in-transaction (or the
        // terminal row pinned from the pre-transaction read). The SAME row id
        // is re-used so the deterministic key keeps one durable identity.
        const reuse = row ?? plan.existing;
        const reservation = new InventoryReservation({
          id: reuse?.id ?? this.idGenerator.generate(),
          reservationKey: key,
          locationId: plan.locationId!,
          variantId: plan.item.variantId,
          quantity: plan.item.quantity,
          status: "reserved",
          orderId,
          expiresAt,
          version: (reuse?.version ?? 0) + 1,
        });

        // Atomic conditional reservation (INV-I2): zero rows => insufficient.
        let reserved: boolean;
        try {
          reserved = await this.inventoryLevelRepository.reserveAvailable(
            plan.locationId!,
            plan.item.variantId,
            plan.item.quantity,
          );
        } catch (err: unknown) {
          throw this.mapRepositoryError(
            err,
            "Failed to reserve inventory level.",
          );
        }
        if (!reserved) {
          this.logger.info("Insufficient inventory for reservation", {
            orderId,
            variantId: plan.item.variantId,
            locationId: plan.locationId,
            quantity: plan.item.quantity,
            actorId,
          });
          throw new DomainError(
            "INSUFFICIENT_INVENTORY",
            `Insufficient available inventory for variant ${plan.item.variantId} at location ${plan.locationId}.`,
          );
        }

        if (reuse) {
          // Existing terminal row: upsert in place (same id, same key).
          try {
            await this.inventoryReservationRepository.save(reservation);
          } catch (err: unknown) {
            throw this.mapRepositoryError(
              err,
              "Failed to persist reservation row.",
            );
          }
        } else {
          // Fresh row: key collision => concurrent winner; abort so OUR
          // decrement rolls back, then replay the winner's committed row.
          let created: boolean;
          try {
            created =
              await this.inventoryReservationRepository.createIfAbsent(
                reservation,
              );
          } catch (err: unknown) {
            throw this.mapRepositoryError(
              err,
              "Failed to persist reservation row.",
            );
          }
          if (!created) {
            throw new ConcurrentReservationError(key);
          }
        }

        lines.push({
          reservationId: reservation.id,
          reservationKey: reservation.reservationKey,
          variantId: reservation.variantId,
          locationId: reservation.locationId,
          quantity: reservation.quantity,
          status: "reserved",
          replayed: false,
        });
      }
    });

    return lines;
  }

  /**
   * Classify each item against the existing order reservations. A prior
   * reserved/confirmed line REPLAYS (identical quantity) or rejects a changed
   * quantity; a terminal line REACTIVATES in place (same node, same id); an
   * absent line goes FRESH and is sourced deterministically.
   */
  private planReservations(
    orderId: string,
    items: ReserveInventoryItem[],
    existingByOrder: InventoryReservation[],
    actorId: string,
  ): Array<{
    item: ReserveInventoryItem;
    mode: "replay" | "reactivate" | "fresh";
    existing: InventoryReservation | null;
    locationId: string | null;
    replayLine: ReservedInventoryLine | null;
  }> {
    return items.map((item) => {
      const existing =
        existingByOrder.find(
          (r) => r.variantId === item.variantId,
        ) ?? null;

      if (existing && (existing.isHeld || existing.status === "confirmed")) {
        if (existing.quantity !== item.quantity) {
          throw new DomainError(
            "INVALID_OPERATION",
            `A reservation already exists for order ${orderId} variant ${item.variantId} with quantity ${existing.quantity}; retries must match the original request.`,
          );
        }
        return {
          item,
          mode: "replay" as const,
          existing,
          locationId: existing.locationId,
          replayLine: {
            reservationId: existing.id,
            reservationKey: existing.reservationKey,
            variantId: existing.variantId,
            locationId: existing.locationId,
            quantity: existing.quantity,
            status: existing.status as "reserved" | "confirmed",
            replayed: true,
          },
        };
      }

      if (existing) {
        // Terminal (released/cancelled/expired): reactivate the SAME node so
        // the deterministic key stays stable.
        return {
          item,
          mode: "reactivate" as const,
          existing,
          locationId: existing.locationId,
          replayLine: null,
        };
      }

      return {
        item,
        mode: "fresh" as const,
        existing: null,
        locationId: null,
        replayLine: null,
      };
    });
  }

  /** Sum quantities per variant and sort by variantId for deterministic replay. */
  private aggregateItems(items: ReserveInventoryItem[]): ReserveInventoryItem[] {
    const byVariant = new Map<string, number>();
    for (const raw of items) {
      const variantId = (raw.variantId ?? "").trim();
      const quantity = Number(raw.quantity);
      if (!variantId) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "Each reservation item requires a variantId.",
        );
      }
      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > ReserveInventoryUseCase.MAX_REQUEST_QTY
      ) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `quantity for variant ${variantId} must be an integer in [1, ${ReserveInventoryUseCase.MAX_REQUEST_QTY}].`,
        );
      }
      byVariant.set(variantId, (byVariant.get(variantId) ?? 0) + quantity);
    }

    return [...byVariant.entries()]
      .map(([variantId, quantity]) => ({ variantId, quantity }))
      .sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));
  }

  private mapRepositoryError(err: unknown, fallback: string): DomainError {
    const repoErr = err as RepositoryError | undefined;
    if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
      return new DomainError(
        "INTERNAL_ERROR",
        "Database connection error while handling inventory.",
      );
    }
    if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
      return new DomainError(
        "INTERNAL_ERROR",
        "Database timeout while handling inventory.",
      );
    }
    if (repoErr?.code === RepositoryErrorCode.NOT_FOUND) {
      return new DomainError(
        "RESOURCE_NOT_FOUND",
        "Referenced record does not exist while handling inventory.",
      );
    }
    return new DomainError("INTERNAL_ERROR", fallback);
  }
}