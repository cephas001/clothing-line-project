// apps/api/src/use-cases/logistics/DispatchOrderFulfillmentUseCase.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import { IFulfillmentRepository } from "@api/domain/interfaces/repositories/IFulfillmentRepository";
import { INotificationOutboxRepository } from "@api/domain/interfaces/repositories/INotificationOutboxRepository";
import { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import type { NotificationIntent } from "@api/domain/shared/notifications";
import { IAuditLogService } from "@api/domain/interfaces/services/IAuditLogService";
import { IIdGenerator } from "@api/domain/interfaces/shared/IIdGenerator";
import { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import { Order } from "@api/domain/entities/Order";
import {
  DispatchState,
  DispatchStateMachine,
} from "@api/domain/shared/dispatchStateMachine";
import {
  FulfillmentRecord,
  JsonObject,
  OrderShippingSnapshot,
  ShippingLabelRequest,
  ShippingLabelResult,
  StructuredMeta,
} from "@api/domain/shared/contracts";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";

/**
 * Use case: dispatch an order for fulfillment by driving a fulfillment record
 * through the DISPATCH state machine (domain/shared/dispatchStateMachine).
 *
 * AUTHORITATIVE DISPATCH INPUT (PART 2 & 3):
 * - The shipment definition comes EXCLUSIVELY from `Order.shippingSnapshot` —
 *   the frozen provider-neutral snapshot (requestToken, selected courier/
 *   service, destination, parcel items) recorded at checkout. Dispatch NEVER
 *   reads today's Cart shipping selection, NEVER calls Shipbubble rates, and
 *   NEVER recalculates shipping.
 * - The shipment ORIGIN comes EXCLUSIVELY from `Order.sourcingSnapshot.origin`
 *   — the frozen provider-neutral origin (name/email/phone/address + the
 *   application location id) recorded at finalization from the primary
 *   inventory location's LOCAL sender record. The logistics adapter consumes it
 *   as authoritative historical context and NEVER decides an origin itself.
 * - If the snapshot is missing or structurally invalid for a finalized order,
 *   the dispatch FAILS CLOSED with INVALID_STATE.
 *
 * DISPATCH STATE MACHINE (PART 4):
 * - Rule A — an existing provider shipment id -> idempotent REPLAY, never a
 *   second POST.
 * - Rule B — an existing `requires_reconciliation` marker -> refuse the create.
 * - Rule C — no shipment yet -> exactly ONE provider create attempt.
 * - Rule D — definite success -> persist provider shipment id + tracking
 *   number durably and mark the order fulfilled.
 * - Rule E — definite rejection -> record the dispatch as `failed`, do NOT
 *   mark the order successful.
 * - Rule F — timeout/network/ambiguous provider response -> persist
 *   `requires_reconciliation` (never blindly retry) and surface
 *   SHIPMENT_REQUIRES_RECONCILIATION.
 *
 * SUCCESSFUL DISPATCH PERSISTENCE (PART 6-8):
 * - The confirmed record persists application order identity, the first-class
 *   `providerShipmentId`, the tracking number, and the (optional) label URL.
 * - If enrichment/persistence fails AFTER the provider created the shipment,
 *   the outcome is classified as requires-reconciliation (the provider holds a
 *   shipment we can no longer describe); a cancel is NOT issued.
 *
 * NOTIFICATION (L8 PART 7): a `shipment_dispatched` intent is appended INSIDE
 * the success-persist transaction (Rule D) — it commits atomically with the
 * durable `dispatched` marker, so it fires only when the shipment is durably
 * dispatched, never on replay/requires_reconciliation. The recipient is the
 * FROZEN `Order.shippingSnapshot.destination.email` — never a webhook/body.
 *
 * TRANSACTION BOUNDARY (PART 5): the provider call is NEVER inside a database
 * transaction. The exact ordering is:
 *   1. Read the authoritative snapshot (order load, no transaction).
 *   2. Check dispatch state / idempotency (the gate, no transaction).
 *   3. Call Shipbubble OUTSIDE any transaction.
 *   4. Persist the successful/ambiguous outcome USING a DB transaction.
 *   5. Audit AFTER the transaction commits.
 * The `dispatch_pending` claim is its OWN short transaction that commits
 * before the POST — it is never held open across the provider HTTP call.
 *
 * DUPLICATE / RACE SAFETY (PART 10): a durable dispatch claim is persisted as
 * `dispatch_pending` BEFORE the provider POST, and the claim is arbitrated at
 * the database by a partial unique index on fulfillment(order_id) restricted to
 * claim/confirmed states (migration 0011). Two concurrent workers can therefore
 * never both POST: the loser's insert raises DUPLICATE and the use case reloads
 * the order and honours the winner's claim (replay / requires_reconciliation).
 * Concurrency is NEVER solved by opening a transaction around the HTTP request.
 *
 * AUDITING (PART 12): audit writes happen only after the corresponding
 * transactionManager.execute(...) resolves. Successful, ambiguous, rejected and
 * replayed dispatches each emit an audit event with safe structured metadata
 * (application order id, provider shipment id, tracking number, state) — never
 * API keys, auth headers, or full provider response bodies.
 */
export interface DispatchOrderFulfillmentInput {
  orderId: string;
  actorId?: string;
}

export interface DispatchOrderFulfillmentResult {
  fulfillmentId: string;
  providerShipmentId: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  courier: string | null;
  serviceLevel: string | null;
  status: string;
  /** Dispatch lifecycle state of the fulfillment record. */
  dispatchState: DispatchState;
  /** True when an existing provider shipment was replayed instead of re-created. */
  replayed: boolean;
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
    private readonly notificationOutboxRepository: INotificationOutboxRepository,
  ) {}

  async execute(
    input: DispatchOrderFulfillmentInput,
  ): Promise<DispatchOrderFulfillmentResult> {
    const orderId = (input.orderId ?? "").trim();
    const actorId = (input.actorId ?? "system").trim() || "system";
    const nowIso = new Date().toISOString();

    // --- Validate input
    if (!orderId) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }

    this.logger.info("Dispatching order fulfillment started", {
      orderId,
      actorId,
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

    // --- Validate order state -------------------------------------------------
    // Dispatch may only happen for an order that has been finalized and is not
    // already fulfilled, returned, or on hold.
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

    // --- AUTHORITATIVE DISPATCH INPUT: the frozen shipping snapshot ----------
    // The shipment definition is EXCLUSIVELY the OrderShippingSnapshot frozen at
    // checkout. Dispatch must never recalculate shipping, never call Shipbubble
    // rates, and never read today's Cart shipping selection. A finalized order
    // MUST carry a valid snapshot; otherwise dispatch fails closed.
    const snapshot = order.shippingSnapshot;
    if (!snapshot) {
      this.logger.error(
        "Order has no frozen shipping snapshot for dispatch",
        { orderId, actorId },
      );
      throw new DomainError(
        "INVALID_STATE",
        "Order has no frozen shipping snapshot; the order was not finalized with a shipping selection.",
      );
    }
    assertValidDispatchSnapshot(snapshot);

    // --- Dispatch gate (rules A/B, and in-flight/terminal guards) -------------
    // Inspect the durable fulfillment records BEFORE any provider POST.
    const gate = inspectDispatchGate(order.fulfillments);

    // Rule B: a previous ambiguous outcome is never re-POSTed automatically.
    if (gate.outcome === "requires_reconciliation") {
      this.logger.error(
        "Order has a pending ambiguous dispatch; refusing to create another shipment",
        { orderId, actorId },
      );
      throw new DomainError(
        "SHIPMENT_REQUIRES_RECONCILIATION",
        "A previous dispatch attempt has an unknown outcome. The order must be reconciled before it can be dispatched again.",
      );
    }

    // An unresolved in-flight attempt (crash between claim and POST, or a
    // process death mid-POST): the outcome is UNKNOWN, so never POST again.
    // Durably upgrade the marker to requires_reconciliation (best-effort) and
    // surface the reconciliation requirement (rule F).
    if (gate.outcome === "in_progress") {
      this.logger.error(
        "Order has an unresolved in-flight dispatch attempt; refusing to create another shipment",
        { orderId, actorId, fulfillmentId: readString(gate.fulfillment, "id") },
      );
      await this.upgradeInFlightAttemptToReconciliation(
        gate.fulfillment,
        orderId,
        nowIso,
        actorId,
      );
      throw new DomainError(
        "SHIPMENT_REQUIRES_RECONCILIATION",
        "A previous dispatch attempt was interrupted with an unknown outcome. The order must be reconciled before it can be dispatched again.",
      );
    }

    // A terminally rejected attempt is never re-attempted automatically.
    if (gate.outcome === "failed") {
      this.logger.error(
        "Order has a terminally failed dispatch attempt; refusing to create another shipment",
        { orderId, actorId, fulfillmentId: readString(gate.fulfillment, "id") },
      );
      throw new DomainError(
        "INVALID_OPERATION",
        "A previous dispatch attempt was rejected by the logistics provider. The order cannot be re-dispatched automatically.",
      );
    }

    // Rule A: an existing provider shipment identity means the shipment EXISTS.
    // Replay it idempotently — NEVER issue another POST.
    if (gate.outcome === "replay") {
      return this.replayExistingShipment(
        gate.fulfillment,
        gate.providerShipmentId,
        orderId,
        nowIso,
        actorId,
      );
    }

    // --- Rule C: exactly one provider create attempt --------------------------
    // Build the request VERBATIM from the frozen snapshots. The logistics adapter
    // consumes it as-is and never chooses a courier, price, address or parcel —
    // and never decides the origin. The origin is the FROZEN
    // `Order.sourcingSnapshot.origin` (resolved from the primary location's
    // LOCAL sender record at finalization); it is null for legacy/custom-only
    // orders that carried no reservations, in which case dispatch proceeds
    // without an origin (the adapter logs the absence; it never invents one).
    const labelRequest: ShippingLabelRequest = {
      orderId: order.id,
      requestToken: snapshot.requestToken,
      selection: snapshot.selection,
      destination: snapshot.destination,
      parcelItems: snapshot.parcelItems,
      dimensions: snapshot.dimensions ?? undefined,
      origin: order.sourcingSnapshot?.origin ?? null,
    };

    // Durably claim the attempt as `dispatch_pending` BEFORE the POST, so a
    // crash between claim and POST leaves a provable in-flight marker.
    const fulfillmentId = this.idGenerator.generate();
    const dispatchMarker: FulfillmentRecord = {
      id: fulfillmentId,
      orderId: order.id,
      trackingNumber: "",
      status: "dispatch_pending",
      // Freeze which inventory location the units came from (the frozen
      // snapshot's primary location) so the fulfillment record is
      // self-contained and never depends on the mutable inventory tables.
      sourcingLocationId: order.sourcingSnapshot?.primaryLocationId ?? undefined,
      createdAt: nowIso,
      metadata: {
        dispatchAttempt: {
          requestedAt: nowIso,
          state: "dispatch_pending",
          requestToken: snapshot.requestToken,
          courierId: snapshot.selection.courierId,
          serviceCode: snapshot.selection.serviceCode,
        },
      },
    };
    try {
      await this.transactionManager.execute(async () => {
        await this.fulfillmentRepository.save(dispatchMarker);
      });
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      // PART 10: a DUPLICATE here means the partial unique dispatch-claim index
      // (migration 0011) rejected our insert because another worker already
      // claimed this order — we LOST the race. We must NOT POST. Reload the
      // order and honour the winner's claim instead of creating a second
      // shipment.
      if (repoErr?.code === RepositoryErrorCode.DUPLICATE) {
        this.logger.warn(
          "Dispatch claim conflict; a concurrent dispatch claimed this order",
          { orderId, fulfillmentId, actorId },
        );
        return this.resolveConcurrentClaim(orderId, nowIso, actorId);
      }
      this.logger.error("Failed to claim dispatch attempt", {
        err,
        orderId,
        fulfillmentId,
      });
      if (repoErr?.code === RepositoryErrorCode.CONNECTION) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database connection error while claiming dispatch attempt.",
        );
      }
      if (repoErr?.code === RepositoryErrorCode.TIMEOUT) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Database timeout while claiming dispatch attempt.",
        );
      }
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to claim dispatch attempt.",
      );
    }

    let labelData: ShippingLabelResult;
    try {
      labelData = await this.logisticsService.createShippingLabel(labelRequest);

      // Defensive: a result without a provider shipment id or tracking number is
      // an ambiguous provider response (the shipment may still exist) — the
      // adapter validates this, but never treat a partial result as success.
      if (
        !labelData ||
        !labelData.providerShipmentId ||
        !labelData.trackingNumber
      ) {
        this.logger.error(
          "Logistics service returned incomplete label data after shipment creation",
          {
            orderId,
            fulfillmentId,
            providerShipmentId: labelData?.providerShipmentId ?? null,
            trackingNumber: labelData?.trackingNumber ?? null,
          },
        );
        await this.transitionDispatchMarker(
          dispatchMarker,
          "ambiguous",
          orderId,
          fulfillmentId,
          null,
          "MALFORMED_RESULT",
          nowIso,
          actorId,
        );
        throw new DomainError(
          "SHIPMENT_REQUIRES_RECONCILIATION",
          "The shipment was created but its details could not be confirmed; the order must be reconciled.",
        );
      }
    } catch (err: unknown) {
      if (err instanceof DomainError && err.code === "SHIPMENT_REQUIRES_RECONCILIATION") {
        throw err;
      }
      const classification = classifyCreateFailure(err);
      this.logger.error("Failed to create shipping label", {
        err,
        orderId,
        actorId,
        fulfillmentId,
        ambiguous: classification.ambiguous,
        providerShipmentId: classification.providerShipmentId ?? undefined,
      });

      // Rule F: ambiguous outcome (timeout / network / 5xx / created-but-
      // unconfirmable) — persist requires_reconciliation, NEVER blindly retry.
      if (classification.ambiguous) {
        await this.transitionDispatchMarker(
          dispatchMarker,
          "ambiguous",
          orderId,
          fulfillmentId,
          classification.providerShipmentId,
          classification.code,
          nowIso,
          actorId,
        );
        throw new DomainError(
          "SHIPMENT_REQUIRES_RECONCILIATION",
          "The shipment creation result is ambiguous; the order must be reconciled before it can be dispatched again.",
        );
      }

      // Rule E: definite rejection — record the terminal failure, do NOT mark
      // the order successful.
      await this.transitionDispatchMarker(
        dispatchMarker,
        "rejected",
        orderId,
        fulfillmentId,
        classification.providerShipmentId,
        classification.code,
        nowIso,
        actorId,
      );

      if (classification.code === RepositoryErrorCode.PERMISSION) {
        throw new DomainError(
          "PERMISSION_DENIED",
          "Insufficient permissions to request shipping label.",
        );
      }
      throw new DomainError(
        "EXTERNAL_SERVICE_ERROR",
        "Logistics provider rejected the shipment creation.",
      );
    }

    // --- Rule D: definite success — persist durably + mark order fulfilled ----
    dispatchMarker.status = DispatchStateMachine.next(
      "dispatch_pending",
      "confirmed",
    );
    dispatchMarker.providerShipmentId = labelData.providerShipmentId;
    dispatchMarker.trackingNumber = labelData.trackingNumber;
    dispatchMarker.labelUrl = labelData.labelUrl ?? null;
    dispatchMarker.courier = labelData.courier ?? "UNKNOWN";
    dispatchMarker.serviceLevel =
      snapshot.selection.serviceLevel ?? labelData.serviceLevel ?? null;
    dispatchMarker.metadata = {
      dispatchAttempt: {
        ...readDispatchAttempt(dispatchMarker.metadata),
        outcome: "confirmed",
        providerShipmentId: labelData.providerShipmentId,
        confirmedAt: nowIso,
      },
    };

    try {
      await this.transactionManager.execute(async () => {
        await this.fulfillmentRepository.save(dispatchMarker);
        order.addFulfillment(dispatchMarker);
        order.setFulfillmentStatus("fulfilled", { updatedAt: nowIso });
        await this.orderRepository.save(order);
        // L8 PART 7: append the shipment_dispatched intent INSIDE the same
        // transaction so it commits atomically with the durable `dispatched`
        // marker + tracking info. The recipient is the FROZEN checkout
        // snapshot address (never a webhook). A duplicate
        // (shipment_dispatched, fulfillmentId) append collides on the unique
        // index, so a concurrent/raced dispatch can never double-notify.
        const shipmentIntent: NotificationIntent = {
          type: "shipment_dispatched",
          payload: {
            recipient: {
              email: snapshot.destination.email,
              name: snapshot.destination.name ?? null,
            },
            order: {
              orderId: order.id,
              cartId: order.cartId,
              customerId: order.customerId,
              currency: order.currency,
              createdAt: order.createdAt,
            },
            fulfillmentId,
            providerShipmentId: dispatchMarker.providerShipmentId ?? "",
            trackingNumber: dispatchMarker.trackingNumber,
            courier:
              typeof dispatchMarker.courier === "string"
                ? dispatchMarker.courier
                : null,
            serviceLevel:
              typeof dispatchMarker.serviceLevel === "string"
                ? dispatchMarker.serviceLevel
                : null,
            labelUrl:
              typeof dispatchMarker.labelUrl === "string"
                ? dispatchMarker.labelUrl
                : null,
            dispatchedAt: nowIso,
          },
        };
        await this.notificationOutboxRepository.append(
          this.idGenerator.generate(),
          shipmentIntent,
        );
      });
    } catch (err: unknown) {
      const repoErr = err as RepositoryError | undefined;
      // PART 8: the provider HAS created the shipment (provider id known) but
      // our enrichment/persistence failed — the durable row is still
      // `dispatch_pending` (this unit of work rolled back). The outcome is
      // ambiguous: the provider holds a shipment we can no longer describe.
      // Persist requires_reconciliation carrying the provider id. A cancel is
      // NOT issued: the shipment exists and cancelling is another POST with an
      // equally unknown outcome.
      this.logger.error(
        "Failed to persist confirmed dispatch; shipment exists at provider",
        {
          err,
          orderId,
          fulfillmentId,
          providerShipmentId: labelData.providerShipmentId,
        },
      );
      await this.transitionDispatchMarker(
        dispatchMarker,
        "ambiguous",
        orderId,
        fulfillmentId,
        labelData.providerShipmentId,
        repoErr?.code ?? RepositoryErrorCode.UNKNOWN,
        nowIso,
        actorId,
      );
      throw new DomainError(
        "SHIPMENT_REQUIRES_RECONCILIATION",
        "The shipment was created but could not be recorded; the order must be reconciled.",
      );
    }

    // --- Audit log (non-blocking)
    try {
      await this.auditLogService.logAction(actorId, "ORDER_DISPATCHED", {
        auditId: this.idGenerator.generate(),
        orderId,
        fulfillmentId,
        trackingNumber: dispatchMarker.trackingNumber,
        providerShipmentId: dispatchMarker.providerShipmentId ?? null,
        courier: dispatchMarker.courier,
        serviceLevel: dispatchMarker.serviceLevel ?? "",
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
      trackingNumber: dispatchMarker.trackingNumber,
      providerShipmentId: dispatchMarker.providerShipmentId ?? null,
    });
    return {
      fulfillmentId,
      providerShipmentId: dispatchMarker.providerShipmentId ?? null,
      trackingNumber: dispatchMarker.trackingNumber,
      labelUrl: readString(dispatchMarker, "labelUrl"),
      courier: readString(dispatchMarker, "courier"),
      serviceLevel: readString(dispatchMarker, "serviceLevel"),
      status: dispatchMarker.status ?? "dispatched",
      dispatchState: "dispatched",
      replayed: false,
    };
  }

  /**
   * PART 10 — resolve a claim conflict where the partial unique dispatch-claim
   * index (migration 0011) rejected our insert because another worker already
   * claimed this order. The order is reloaded and the WINNER's claim is
   * honoured: replay if a provider shipment now exists, otherwise refuse with
   * the appropriate state. This use case NEVER re-inserts and NEVER POSTs.
   */
  private async resolveConcurrentClaim(
    orderId: string,
    nowIso: string,
    actorId: string,
  ): Promise<DispatchOrderFulfillmentResult> {
    let freshOrder: Order | null;
    try {
      freshOrder = await this.orderRepository.findById(orderId);
    } catch (err: unknown) {
      this.logger.error(
        "Failed to reload order after dispatch claim conflict",
        { err, orderId, actorId },
      );
      throw new DomainError(
        "INTERNAL_ERROR",
        "Failed to resolve concurrent dispatch claim.",
      );
    }
    if (!freshOrder) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Order not found.");
    }

    const gate = inspectDispatchGate(freshOrder.fulfillments);
    if (gate.outcome === "replay") {
      // The winning worker confirmed a provider shipment — replay it.
      return this.replayExistingShipment(
        gate.fulfillment,
        gate.providerShipmentId,
        orderId,
        nowIso,
        actorId,
      );
    }
    if (gate.outcome === "in_progress") {
      // The winner claimed but never confirmed; outcome unknown (rule F).
      await this.upgradeInFlightAttemptToReconciliation(
        gate.fulfillment,
        orderId,
        nowIso,
        actorId,
      );
      throw new DomainError(
        "SHIPMENT_REQUIRES_RECONCILIATION",
        "A concurrent dispatch attempt claimed this order with an unknown outcome. The order must be reconciled before it can be dispatched again.",
      );
    }
    if (gate.outcome === "requires_reconciliation") {
      throw new DomainError(
        "SHIPMENT_REQUIRES_RECONCILIATION",
        "A previous dispatch attempt has an unknown outcome. The order must be reconciled before it can be dispatched again.",
      );
    }
    if (gate.outcome === "failed") {
      throw new DomainError(
        "INVALID_OPERATION",
        "A previous dispatch attempt was rejected by the logistics provider. The order cannot be re-dispatched automatically.",
      );
    }
    // No claim is visible even though the index rejected ours: the winning
    // claim was concurrently terminalized, or the data is inconsistent. Never
    // invent a claim — refuse with a clear concurrency error.
    throw new DomainError(
      "INVALID_OPERATION",
      "A concurrent dispatch claim could not be resolved.",
    );
  }

  /**
   * Rule A — idempotently replay an existing provider shipment. Never a POST:
   * the provider shipment id proves the shipment exists. Emits an
   * ORDER_DISPATCH_REPLAYED audit event after the (non-)transactional read.
   */
  private async replayExistingShipment(
    existing: JsonObject,
    providerShipmentId: string,
    orderId: string,
    nowIso: string,
    actorId: string,
  ): Promise<DispatchOrderFulfillmentResult> {
    this.logger.info(
      "Replaying existing provider shipment (idempotent dispatch)",
      { orderId, providerShipmentId, actorId },
    );
    try {
      await this.auditLogService.logAction(
        actorId,
        "ORDER_DISPATCH_REPLAYED",
        {
          auditId: this.idGenerator.generate(),
          orderId,
          fulfillmentId: readString(existing, "id") ?? orderId,
          providerShipmentId,
          trackingNumber: readString(existing, "trackingNumber") ?? "",
          replayedAt: nowIso,
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for idempotent dispatch replay", {
        err: auditErr,
        orderId,
        actorId,
      });
    }
    return {
      fulfillmentId: readString(existing, "id") ?? orderId,
      providerShipmentId,
      trackingNumber: readString(existing, "trackingNumber"),
      labelUrl: readString(existing, "labelUrl"),
      courier: readString(existing, "courier"),
      serviceLevel: readString(existing, "serviceLevel"),
      status: readString(existing, "status") ?? "dispatched",
      dispatchState: "dispatched",
      replayed: true,
    };
  }

  /**
   * Transition a claimed `dispatch_pending` record to its failure state
   * (`requires_reconciliation` for ambiguous, `failed` for a definite
   * rejection) and persist it durably. Best-effort: a persistence failure must
   * never mask the reconciliation requirement or the terminal failure — the
   * state machine's durable record is written when possible and the error is
   * always surfaced by the caller.
   */
  private async transitionDispatchMarker(
    marker: FulfillmentRecord,
    event: "ambiguous" | "rejected",
    orderId: string,
    fulfillmentId: string,
    providerShipmentId: string | null,
    failureCode: string,
    attemptedAt: string,
    actorId: string,
  ): Promise<void> {
    const nextState = DispatchStateMachine.next("dispatch_pending", event);
    const attempt = readDispatchAttempt(marker.metadata);
    marker.status = nextState;
    marker.metadata = {
      dispatchAttempt: {
        ...attempt,
        outcome:
          providerShipmentId && event === "ambiguous"
            ? "created_unconfirmed"
            : event === "ambiguous"
              ? "ambiguous"
              : "rejected",
        failureCode,
        attemptedAt,
        ...(providerShipmentId ? { providerShipmentId } : {}),
      },
    };
    if (providerShipmentId) {
      marker.providerShipmentId = providerShipmentId;
    }

    try {
      await this.transactionManager.execute(async () => {
        await this.fulfillmentRepository.save(marker);
      });
    } catch (persistErr: unknown) {
      this.logger.error("Failed to persist dispatch outcome marker", {
        err: persistErr,
        orderId,
        fulfillmentId,
        nextState,
      });
    }

    const auditAction =
      event === "ambiguous"
        ? "ORDER_DISPATCH_REQUIRES_RECONCILIATION"
        : "ORDER_DISPATCH_FAILED";
    try {
      await this.auditLogService.logAction(actorId, auditAction, {
        auditId: this.idGenerator.generate(),
        orderId,
        fulfillmentId,
        providerShipmentId: providerShipmentId ?? undefined,
        failureCode,
        attemptedAt,
        state: nextState,
      });
    } catch (auditErr: unknown) {
      this.logger.warn(`Audit log failed for ${auditAction}`, {
        err: auditErr,
        orderId,
        fulfillmentId,
      });
    }

    this.logger.warn(`Dispatch outcome recorded as ${nextState}`, {
      orderId,
      fulfillmentId,
      providerShipmentId: providerShipmentId ?? undefined,
      failureCode,
      attemptedAt,
    });
  }

  /**
   * Best-effort upgrade of a found `dispatch_pending` record (an interrupted
   * in-flight attempt) to `requires_reconciliation`. The outcome of that
   * attempt is unknown, so it becomes durable reconciliation state.
   */
  private async upgradeInFlightAttemptToReconciliation(
    fulfillment: JsonObject,
    orderId: string,
    attemptedAt: string,
    actorId: string,
  ): Promise<void> {
    const fulfillmentId = readString(fulfillment, "id") ?? this.idGenerator.generate();
    const existingMeta =
      fulfillment.metadata && typeof fulfillment.metadata === "object"
        ? (fulfillment.metadata as JsonObject)
        : {};
    const upgraded: FulfillmentRecord = {
      ...(fulfillment as JsonObject),
      id: fulfillmentId,
      orderId: readString(fulfillment, "orderId") ?? orderId,
      trackingNumber: readString(fulfillment, "trackingNumber") ?? "",
      status: "requires_reconciliation",
      metadata: {
        dispatchAttempt: {
          ...readDispatchAttempt(existingMeta),
          outcome: "interrupted_unknown",
          recoveryUpgradedAt: attemptedAt,
        },
      },
    };
    try {
      await this.transactionManager.execute(async () => {
        await this.fulfillmentRepository.save(upgraded);
      });
    } catch (persistErr: unknown) {
      this.logger.warn(
        "Failed to upgrade in-flight dispatch marker to requires_reconciliation",
        { err: persistErr, orderId, fulfillmentId },
      );
    }
    try {
      await this.auditLogService.logAction(
        actorId,
        "ORDER_DISPATCH_REQUIRES_RECONCILIATION",
        {
          auditId: this.idGenerator.generate(),
          orderId,
          fulfillmentId,
          failureCode: "INTERRUPTED",
          attemptedAt,
          state: "requires_reconciliation",
        },
      );
    } catch (auditErr: unknown) {
      this.logger.warn("Audit log failed for interrupted dispatch", {
        err: auditErr,
        orderId,
        fulfillmentId,
      });
    }
  }
}

/**
 * Classify a shipment-creation failure by how much is known about its outcome.
 * `ambiguous` is true whenever the create request may or may not have been
 * processed (timeout / network / 5xx / provider id known-but-unconfirmable /
 * malformed response): the use case must then persist
 * `requires_reconciliation` and MUST NOT issue another POST. A non-ambiguous
 * failure is a DEFINITE rejection (the provider validated the request and
 * rejected it; no shipment exists).
 */
function classifyCreateFailure(err: unknown): {
  ambiguous: boolean;
  providerShipmentId: string | null;
  code: RepositoryErrorCode;
} {
  const svcErr = err as (RepositoryError & { meta?: StructuredMeta }) | undefined;
  const svcMeta = svcErr?.meta as
    | { ambiguous?: boolean; providerShipmentId?: string }
    | undefined;
  const providerShipmentId =
    typeof svcMeta?.providerShipmentId === "string" &&
    svcMeta.providerShipmentId.trim().length > 0
      ? svcMeta.providerShipmentId.trim()
      : null;
  const ambiguous =
    svcMeta?.ambiguous === true ||
    svcErr?.code === RepositoryErrorCode.CONNECTION ||
    svcErr?.code === RepositoryErrorCode.TIMEOUT;
  return {
    ambiguous,
    providerShipmentId,
    code: svcErr?.code ?? RepositoryErrorCode.UNKNOWN,
  };
}

/**
 * Structural validation of the frozen dispatch input. The snapshot is the
 * ONLY authority for the shipment; if it is malformed for a finalized order
 * the dispatch FAILS CLOSED (INVALID_STATE) instead of sending a partial
 * definition to the provider.
 */
function assertValidDispatchSnapshot(snapshot: OrderShippingSnapshot): void {
  const problem = (msg: string): never => {
    throw new DomainError(
      "INVALID_STATE",
      `Order shipping snapshot is invalid for dispatch: ${msg}`,
    );
  };

  const token = (snapshot.requestToken ?? "").trim();
  const courierId = (snapshot.selection?.courierId ?? "").trim();
  const serviceCode = (snapshot.selection?.serviceCode ?? "").trim();
  const amountMinor = snapshot.selection?.amountMinor;
  const destination = snapshot.destination;
  const name = (destination?.name ?? "").trim();
  const email = (destination?.email ?? "").trim();

  if (!token) problem("missing requestToken");
  if (!courierId) problem("missing selection.courierId");
  if (!serviceCode) problem("missing selection.serviceCode");
  if (
    typeof amountMinor !== "number" ||
    !Number.isInteger(amountMinor) ||
    amountMinor < 0
  ) {
    problem("invalid selection.amountMinor");
  }
  if (!destination || !name || !email) {
    problem("missing destination name/email");
  }
  if (!Array.isArray(snapshot.parcelItems) || snapshot.parcelItems.length === 0) {
    problem("missing parcelItems");
  }
}

/**
 * Inspect the order's durable fulfillment records for the dispatch gate:
 *   - `requires_reconciliation` (rule B) — a recorded ambiguous outcome takes
 *     precedence over everything: refuse the create.
 *   - `replay` (rule A) — an existing provider shipment id means the shipment
 *     EXISTS: replay, never POST. (First-class field, falling back to the
 *     legacy metadata.logisticsResponse.providerReference.)
 *   - `in_progress` — a `dispatch_pending` marker from an interrupted attempt:
 *     outcome unknown; refuse (reconcile first).
 *   - `failed` — a terminally rejected attempt: refuse automatic re-dispatch.
 *   - `not_attempted` — no row: a create attempt may start.
 */
function inspectDispatchGate(
  fulfillments: JsonObject[],
):
  | { outcome: "not_attempted" }
  | { outcome: "requires_reconciliation"; fulfillment: JsonObject }
  | { outcome: "replay"; fulfillment: JsonObject; providerShipmentId: string }
  | { outcome: "in_progress"; fulfillment: JsonObject }
  | { outcome: "failed"; fulfillment: JsonObject } {
  for (const entry of fulfillments) {
    if (
      entry &&
      typeof entry === "object" &&
      readString(entry, "status") === "requires_reconciliation"
    ) {
      return { outcome: "requires_reconciliation", fulfillment: entry };
    }
  }
  for (const entry of fulfillments) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const providerShipmentId = readProviderShipmentId(entry);
    if (providerShipmentId) {
      return { outcome: "replay", fulfillment: entry, providerShipmentId };
    }
  }
  for (const entry of fulfillments) {
    if (
      entry &&
      typeof entry === "object" &&
      readString(entry, "status") === "dispatch_pending"
    ) {
      return { outcome: "in_progress", fulfillment: entry };
    }
  }
  for (const entry of fulfillments) {
    if (
      entry &&
      typeof entry === "object" &&
      readString(entry, "status") === "failed"
    ) {
      return { outcome: "failed", fulfillment: entry };
    }
  }
  return { outcome: "not_attempted" };
}

/**
 * Resolve the PROVIDER shipment identity of a fulfillment record: the
 * first-class `providerShipmentId` field, falling back to the legacy
 * `metadata.logisticsResponse.providerReference`. Always the provider's id —
 * never the application orderId.
 */
function readProviderShipmentId(entry: JsonObject): string | null {
  const direct = readString(entry, "providerShipmentId");
  if (direct) {
    return direct;
  }
  const metadata = entry.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const logisticsResponse = (metadata as JsonObject)["logisticsResponse"];
    if (
      logisticsResponse &&
      typeof logisticsResponse === "object" &&
      !Array.isArray(logisticsResponse)
    ) {
      return readString(logisticsResponse as JsonObject, "providerReference");
    }
  }
  return null;
}

/** Read the dispatchAttempt sub-object of a fulfillment metadata payload. */
function readDispatchAttempt(metadata: unknown): JsonObject {
  const meta =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as JsonObject)
      : {};
  const attempt = meta["dispatchAttempt"];
  return attempt && typeof attempt === "object" && !Array.isArray(attempt)
    ? (attempt as JsonObject)
    : {};
}

/** Read a trimmed non-empty string field from a JSON object. */
function readString(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
