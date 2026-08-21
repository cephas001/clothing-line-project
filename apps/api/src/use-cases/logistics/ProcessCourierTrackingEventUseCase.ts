// apps/api/src/use-cases/logistics/ProcessCourierTrackingEventUseCase.ts

// Application use case that processes a provider-neutral logistics event
// (produced by the Shipbubble webhook mapper) and reconciles it against the
// DURABLE fulfillment record in PostgreSQL. This is the consumer the
// LogisticsEventWorker routes every logistics-events-queue job through.
//
// Processing flow (PART 9/10/11/12):
//   1. Validate the payload against the `LogisticsEventJobPayload` contract
//      (defense-in-depth; a malformed payload is a permanent failure).
//   2. Resolve the local fulfillment by `providerShipmentId` — NEVER by
//      orderId, trackingNumber, or cartId. If no local fulfillment resolves,
//      the event is classified as operational reconciliation
//      (LOGISTICS_EVENT_FULFILLMENT_NOT_FOUND, retryable but bounded by the
//      producer's attempts) — a fulfillment is NEVER fabricated from a webhook.
//      The ONE exception is the generic `courier` tracking provider (the
//      /store/webhooks/courier-tracking webhook), whose payload carries NO
//      provider shipment identity: for `provider === "courier"` events the
//      local fulfillment is resolved by `trackingNumber` as a fallback (the
//      tracking number IS the courier's only cross-boundary identity).
//   3. Unknown event types are safely acknowledged + audited — they never crash
//      the worker and never enter a retry loop.
//   4. If the event carries an occurrence timestamp, stale events (older than
//      or equal to the stored tracking update) are dropped idempotently. No
//      distributed clocks are introduced.
//   5. Provider events are mapped onto the DOMAIN state machines:
//        - courier tracking progress through CourierTrackingStateMachine
//          (rejects impossible backwards transitions, e.g. DELIVERED ->
//          IN_TRANSIT, with INVALID_STATUS_TRANSITION);
//        - an ambiguous dispatch (`requires_reconciliation`) advances to
//          `dispatched` ONLY via DispatchStateMachine.next(state,
//          "confirmed_by_tracking") when the event carries authoritative
//          provider evidence. A create request is NEVER initiated here.
//   6. Persist local DB state ONLY through the injected ITransactionManager —
//      no Shipbubble, Redis, or BullMQ calls happen inside the transaction.
//   7. Audit logging happens AFTER the transaction commits (PART 20).
//   8. A `tracking_update` notification intent is appended INSIDE the
//      transaction (commits atomically with the tracking state change) and
//      relayed to the notification queue AFTER commit; a notification failure
//      never rolls back the persisted fulfillment state (L8 PART 8/9).
//
// TRANSACTION BOUNDARY (PART 19): the webhook HTTP request (Part 2) already
// completed; this use case runs in the worker and holds a PostgreSQL
// transaction ONLY around the local fulfillment write. Nothing external is
// awaited inside it.

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Order } from "@api/domain/entities/Order";
import { IFulfillmentRepository } from "@api/domain/interfaces/repositories/IFulfillmentRepository";
import { INotificationOutboxRepository } from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  CourierTrackingEvent,
  CourierTrackingState,
  CourierTrackingStateMachine,
} from "@api/domain/shared/trackingStateMachine";
import {
  DispatchState,
  DispatchStateMachine,
} from "@api/domain/shared/dispatchStateMachine";
import {
  FulfillmentRecord,
  JsonObject,
} from "@api/domain/shared/contracts";
import { LogisticsEventJobPayload } from "@api/domain/shared/jobs";
import type { NotificationIntent } from "@api/domain/shared/notifications";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

export interface ProcessCourierTrackingEventInput {
  /** The provider-neutral logistics event the worker consumed. */
  logisticsEvent: LogisticsEventJobPayload;
  actorId?: string;
}

export interface ProcessCourierTrackingEventResult {
  outcome:
    | "processed"
    | "ignored_unknown"
    | "ignored_stale"
    | "ignored_no_change";
  fulfillmentId: string | null;
  providerShipmentId: string;
  previousDispatchState: string | null;
  dispatchState: string | null;
  previousTrackingState: CourierTrackingState | null;
  trackingState: CourierTrackingState | null;
  changed: boolean;
}

export class ProcessCourierTrackingEventUseCase {
  constructor(
    private readonly fulfillmentRepository: IFulfillmentRepository,
    private readonly transactionManager: ITransactionManager,
    private readonly auditLogService: IAuditLogService,
    private readonly idGenerator: IIdGenerator,
    private readonly logger: ILogger,
    private readonly orderRepository: IOrderRepository,
    private readonly notificationOutboxRepository: INotificationOutboxRepository,
  ) {}

  async execute(
    input: ProcessCourierTrackingEventInput,
  ): Promise<ProcessCourierTrackingEventResult> {
    const actorId = (input.actorId ?? "system").trim() || "system";
    const event = input.logisticsEvent;
    const {
      providerShipmentId,
      eventType,
      status,
      trackingNumber,
      courier,
      occurredAt,
      eventKey,
    } = event;

    // --- 1. Resolve the local fulfillment by PROVIDER shipment id ------------
    let fulfillment: FulfillmentRecord | null = null;
    try {
      fulfillment =
        await this.fulfillmentRepository.findByProviderShipmentId(
          providerShipmentId,
        );
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error(
        "Failed to resolve fulfillment by provider shipment id",
        { err, providerShipmentId, eventKey, actorId },
      );
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while resolving fulfillment.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while resolving fulfillment.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to resolve fulfillment for logistics event.",
      );
    }

    // --- 2. Missing local fulfillment -> operational reconciliation ----------
    // NEVER fabricate a fulfillment from a webhook. This is retryable (the
    // fulfillment may be written moments later by dispatch) but bounded by the
    // producer's attempts — never an infinite retry loop.
    //
    // COURIER PROVIDER FALLBACK: the generic courier-tracking webhook payload
    // carries NO provider shipment identity (only a tracking number). For
    // `provider === "courier"` events, when the providerShipmentId lookup
    // misses (the mapper projects providerShipmentId = trackingNumber), the
    // local fulfillment is resolved by trackingNumber — the courier's only
    // cross-boundary identity. The lookup is scoped to courier events so the
    // shipbubble invariant (provider shipment id ONLY) is preserved.
    let fallbackResolved = false;
    if (!fulfillment && event.provider === "courier" && trackingNumber) {
      try {
        fulfillment =
          await this.fulfillmentRepository.findByTrackingNumber(trackingNumber);
        fallbackResolved = fulfillment !== null;
      } catch (err: unknown) {
        const repoErr = err as RepositoryError | undefined;
        this.logger.warn(
          "Failed to resolve fulfillment by tracking number for courier event",
          { err, trackingNumber, eventKey, actorId },
        );
        if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database connection error while resolving fulfillment by tracking number.",
          );
        }
        if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
          throw new DomainError(
            "INTERNAL_ERROR",
            "Database timeout while resolving fulfillment by tracking number.",
          );
        }
        throw new DomainError(
          "INTERNAL_ERROR",
          "Failed to resolve fulfillment for courier tracking event.",
        );
      }
    }

    if (fallbackResolved) {
      this.logger.info(
        "Courier tracking event resolved fulfillment by tracking number",
        { trackingNumber, fulfillmentId: fulfillment?.id, eventKey, actorId },
      );
    }

    if (!fulfillment) {
      this.logger.warn(
        "Logistics event references unknown provider shipment id; classifying for operational reconciliation",
        { providerShipmentId, eventKey, eventType, actorId },
      );
      throw new DomainError(
        "LOGISTICS_EVENT_FULFILLMENT_NOT_FOUND",
        `No local fulfillment exists for provider shipment "${providerShipmentId}".`,
      );
    }

    const fulfillmentId = fulfillment.id;
    const currentDispatchState = readDispatchState(fulfillment.status);
    const trackingMeta = readTrackingMeta(fulfillment.metadata);
    const currentTrackingState = trackingMeta.status;

    // --- 3. Unknown event types: acknowledge + audit, never crash -------------
    if (eventType === "unknown") {
      await this.audit("LOGISTICS_EVENT_IGNORED_UNKNOWN", {
        fulfillmentId,
        providerShipmentId,
        eventKey,
        rawStatus: status ?? null,
        occurredAt: occurredAt ?? null,
      });
      this.logger.info("Ignored logistics event with unknown event type", {
        providerShipmentId,
        eventKey,
        status: status ?? null,
      });
      return {
        outcome: "ignored_unknown",
        fulfillmentId,
        providerShipmentId,
        previousDispatchState: currentDispatchState,
        dispatchState: currentDispatchState,
        previousTrackingState: currentTrackingState,
        trackingState: currentTrackingState,
        changed: false,
      };
    }

    // --- 4. Stale events: drop idempotently when timestamps are present ------
    // Compare the provider occurrence time against the stored tracking update
    // time. No distributed clocks are introduced; when either side is absent
    // the staleness guard simply does not apply (the state machine's
    // transition guard still protects against backwards moves).
    if (occurredAt && trackingMeta.updatedAt) {
      const incomingTs = Date.parse(occurredAt);
      const storedTs = Date.parse(trackingMeta.updatedAt);
      if (
        !Number.isNaN(incomingTs) &&
        !Number.isNaN(storedTs) &&
        incomingTs <= storedTs
      ) {
        await this.audit("LOGISTICS_EVENT_IGNORED_STALE", {
          fulfillmentId,
          providerShipmentId,
          eventKey,
          previousTrackingState: currentTrackingState,
          incomingStatus: status ?? null,
          storedAt: trackingMeta.updatedAt,
          incomingAt: occurredAt,
        });
        this.logger.info("Ignored stale logistics event", {
          fulfillmentId,
          providerShipmentId,
          eventKey,
          storedAt: trackingMeta.updatedAt,
          incomingAt: occurredAt,
        });
        return {
          outcome: "ignored_stale",
          fulfillmentId,
          providerShipmentId,
          previousDispatchState: currentDispatchState,
          dispatchState: currentDispatchState,
          previousTrackingState: currentTrackingState,
          trackingState: currentTrackingState,
          changed: false,
        };
      }
    }

    // --- 5. Map the provider event onto the domain state machines ------------
    const trackingEvent = toTrackingEvent(eventType, status ?? null);

    // 5a. Dispatch ambiguity resolution: authoritative provider evidence
    //     (a courier tracking event, or a shipment.created) advances an
    //     ambiguous dispatch ONLY if the dispatch state machine permits it.
    //     A create request is NEVER initiated from a webhook.
    let nextDispatchState = currentDispatchState;
    const hasAuthoritativeEvidence =
      trackingEvent !== null || eventType === "shipment.created";
    if (
      hasAuthoritativeEvidence &&
      currentDispatchState !== "dispatched" &&
      currentDispatchState !== null
    ) {
      try {
        nextDispatchState = DispatchStateMachine.next(
          currentDispatchState,
          "confirmed_by_tracking",
        );
      } catch (err: unknown) {
        if (err instanceof DomainError && err.code === "INVALID_STATE") {
          // The state machine does not permit the advance (e.g. `failed`, or
          // the record is already `dispatched`); the dispatch state is kept as
          // it is and only the tracking progress (if any) is processed.
          nextDispatchState = currentDispatchState;
        } else {
          throw err;
        }
      }
    }

    // 5b. Courier tracking progress: apply the tracking state machine. An
    //     impossible backwards transition (e.g. DELIVERED -> IN_TRANSIT) is a
    //     TERMINAL rejection (INVALID_STATUS_TRANSITION) — never retried into
    //     an infinite loop, never silently overwriting durable state.
    let nextTrackingState = currentTrackingState;
    if (trackingEvent !== null) {
      if (currentTrackingState === null) {
        // First tracking event for this shipment: adopt the normalized state.
        nextTrackingState = trackingEvent;
      } else {
        nextTrackingState = CourierTrackingStateMachine.next(
          currentTrackingState,
          trackingEvent,
        );
      }
    }

    const dispatchChanged = nextDispatchState !== currentDispatchState;
    const trackingChanged = nextTrackingState !== currentTrackingState;
    const changed = dispatchChanged || trackingChanged;

    // No meaningful change (e.g. a same-state tracking event with no dispatch
    // advance): acknowledge idempotently and audit.
    if (!changed && trackingEvent === null) {
      await this.audit("LOGISTICS_EVENT_IGNORED_NO_CHANGE", {
        fulfillmentId,
        providerShipmentId,
        eventKey,
        eventType,
        status: status ?? null,
      });
      return {
        outcome: "ignored_no_change",
        fulfillmentId,
        providerShipmentId,
        previousDispatchState: currentDispatchState,
        dispatchState: currentDispatchState,
        previousTrackingState: currentTrackingState,
        trackingState: currentTrackingState,
        changed: false,
      };
    }

    // --- 6. Persist local DB state ONLY inside the transaction ----------------
    const updated: FulfillmentRecord = { ...fulfillment };
    if (dispatchChanged && nextDispatchState !== null) {
      updated.status = nextDispatchState;
    }
    if (trackingEvent !== null && nextTrackingState !== null) {
      updated.metadata = {
        ...(isJsonObject(fulfillment.metadata) ? fulfillment.metadata : {}),
        tracking: {
          status: nextTrackingState,
          updatedAt: occurredAt ?? new Date().toISOString(),
          eventKey,
        },
      };
    }
    // Enrich the record with provider facts only when they are missing — the
    // webhook is never the authority for anything the local record already
    // knows.
    if (!updated.trackingNumber && trackingNumber) {
      updated.trackingNumber = trackingNumber;
    }
    if (!updated.courier && courier) {
      updated.courier = courier;
    }

    // --- 5c. Resolve the notification recipient (L8 PART 8/9) -----------------
    // A tracking-progress change that will be committed triggers a
    // `tracking_update` intent. The recipient is the FROZEN checkout
    // `Order.shippingSnapshot.destination.email` — never the webhook body.
    // Loading the order is best-effort: a missing order skips the
    // notification, never the state transition.
    let notificationOrder: Order | null = null;
    if (trackingChanged && nextTrackingState !== null) {
      try {
        notificationOrder = await this.orderRepository.findById(updated.orderId);
      } catch (err: unknown) {
        this.logger.warn(
          "Failed to load order for tracking notification (notification skipped)",
          { err, fulfillmentId, orderId: updated.orderId },
        );
        notificationOrder = null;
      }
    }
    const notificationContext =
      notificationOrder &&
      (notificationOrder.shippingSnapshot?.destination?.email ?? "").trim()
        ? {
            email: (notificationOrder.shippingSnapshot?.destination?.email ?? "").trim(),
            name: notificationOrder.shippingSnapshot?.destination?.name ?? null,
            order: notificationOrder,
          }
        : null;

    try {
      await this.transactionManager.execute(async () => {
        await this.fulfillmentRepository.save(updated);
        // L8 PART 8/9: append the tracking_update intent INSIDE the
        // transaction so it commits atomically with the tracking state
        // change — including the TERMINAL `delivered` transition (a
        // same-state `delivered` replay leaves `trackingChanged` false and
        // cannot re-notify). The per-occurrence discriminator (eventKey)
        // makes an identical event idempotent on the unique index.
        if (
          trackingChanged &&
          nextTrackingState !== null &&
          notificationContext &&
          event.notifyCustomer !== false
        ) {
          const trackingIntent: NotificationIntent = {
            type: "tracking_update",
            payload: {
              recipient: {
                email: notificationContext.email,
                name: notificationContext.name,
              },
              order: {
                orderId: notificationContext.order.id,
                cartId: notificationContext.order.cartId,
                customerId: notificationContext.order.customerId,
                currency: notificationContext.order.currency,
                createdAt: notificationContext.order.createdAt,
              },
              fulfillmentId,
              trackingNumber: updated.trackingNumber,
              courier:
                typeof updated.courier === "string" ? updated.courier : null,
              status: nextTrackingState,
              occurredAt: occurredAt ?? new Date().toISOString(),
            },
          };
          await this.notificationOutboxRepository.append(
            this.idGenerator.generate(),
            trackingIntent,
            { discriminator: eventKey },
          );
        }
      });
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      this.logger.error("Failed to persist logistics event reconciliation", {
        err,
        fulfillmentId,
        providerShipmentId,
        eventKey,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while persisting logistics event.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while persisting logistics event.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to persist logistics event reconciliation.",
      );
    }

    // --- 7. Audit AFTER the transaction committed (PART 20) -------------------
    await this.audit("LOGISTICS_EVENT_PROCESSED", {
      fulfillmentId,
      providerShipmentId,
      orderId: updated.orderId,
      eventKey,
      eventType,
      previousDispatchState: currentDispatchState,
      dispatchState: nextDispatchState,
      previousTrackingState: currentTrackingState,
      trackingState: nextTrackingState,
      trackingNumber: updated.trackingNumber,
      occurredAt: occurredAt ?? null,
      dispatchChanged: String(dispatchChanged),
      trackingChanged: String(trackingChanged),
    });

    // --- 8. Customer notification (L8 PART 8/9) -------------------------------
    // The `tracking_update` intent was appended INSIDE the transaction above,
    // so it commits atomically with the tracking state change and is relayed
    // to the notification queue after commit by
    // EnqueuePendingNotificationsUseCase. A notification failure can therefore
    // never roll back the persisted fulfillment state.

    this.logger.info("Processed logistics event", {
      fulfillmentId,
      providerShipmentId,
      eventKey,
      eventType,
      outcome: "processed",
      dispatchChanged,
      trackingChanged,
    });

    return {
      outcome: "processed",
      fulfillmentId,
      providerShipmentId,
      previousDispatchState: currentDispatchState,
      dispatchState: nextDispatchState,
      previousTrackingState: currentTrackingState,
      trackingState: nextTrackingState,
      changed,
    };
  }

  /** Non-blocking audit write; an audit failure never fails the event. */
  private async audit(
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogService.logAction(
        details.actorId as string | undefined ?? "system",
        action,
        {
          auditId: this.idGenerator.generate(),
          processedAt: new Date().toISOString(),
          ...details,
        },
      );
    } catch (err: unknown) {
      this.logger.warn(`Audit log failed for ${action}`, { err });
    }
  }
}

// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------

/** Map a normalized provider event onto the courier tracking vocabulary. */
function toTrackingEvent(
  eventType: LogisticsEventJobPayload["eventType"],
  status: string | null,
): CourierTrackingEvent | null {
  switch (eventType) {
    case "delivery.completed":
      return "delivered";
    case "delivery.exception":
      return "delivery_failed";
    case "delivery.attempted":
      return "out_for_delivery";
    case "tracking.status_changed": {
      if (status === "out_for_delivery") return "out_for_delivery";
      if (status === "delivered") return "delivered";
      if (status === "failed_attempt") return "delivery_failed";
      return "in_transit";
    }
    case "shipment.created":
    case "shipment.cancelled":
    case "unknown":
      return null;
    default:
      return null;
  }
}

/** The fulfillment `status` carries the DISPATCH lifecycle state. */
function readDispatchState(status: string | undefined): DispatchState | null {
  const value = (status ?? "").trim();
  if (
    value === "not_attempted" ||
    value === "dispatch_pending" ||
    value === "dispatched" ||
    value === "requires_reconciliation" ||
    value === "failed"
  ) {
    return value;
  }
  return null;
}

interface TrackingMeta {
  status: CourierTrackingState | null;
  updatedAt: string | null;
}

/** Read `metadata.tracking` written by this use case (absent -> null state). */
function readTrackingMeta(metadata: unknown): TrackingMeta {
  if (!isJsonObject(metadata)) {
    return { status: null, updatedAt: null };
  }
  const tracking = metadata["tracking"];
  if (!isJsonObject(tracking)) {
    return { status: null, updatedAt: null };
  }
  const rawStatus = tracking["status"];
  const updatedAt = tracking["updatedAt"];
  const status =
    typeof rawStatus === "string" &&
    (rawStatus === "in_transit" ||
      rawStatus === "out_for_delivery" ||
      rawStatus === "delivered" ||
      rawStatus === "delivery_failed")
      ? rawStatus
      : null;
  return {
    status,
    updatedAt: typeof updatedAt === "string" && updatedAt.length > 0 ? updatedAt : null,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}
