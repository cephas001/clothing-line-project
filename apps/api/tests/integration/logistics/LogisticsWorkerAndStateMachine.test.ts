// apps/api/tests/integration/logistics/LogisticsWorkerAndStateMachine.test.ts
//
// L6 Part 3 — logistics worker consumer + domain state machines.
//
// Proves ProcessCourierTrackingEventUseCase (what LogisticsEventWorker routes
// every queue job through) reconciles webhook evidence against the DURABLE
// fulfillment record:
//   - a webhook NEVER fabricates a fulfillment and NEVER creates a shipment;
//   - missing/duplicate/stale/out-of-order/unknown events are handled safely;
//   - impossible regressions (delivered -> in_transit) are rejected terminally;
//   - the dispatch axis and the tracking axis are INDEPENDENT: authoritative
//     provider evidence resolves `requires_reconciliation` -> `dispatched` (the
//     ONLY webhook exit), while a terminally `failed` dispatch never advances.

import {
  CourierTrackingStateMachine,
} from "@api/domain/shared/trackingStateMachine";
import { DispatchStateMachine } from "@api/domain/shared/dispatchStateMachine";
import {
  buildLogisticsEvent,
  createLogisticsHarness,
} from "./logisticsHarness";
import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";

const T1 = "2026-08-15T10:00:00Z";
const T2 = "2026-08-15T11:00:00Z";

function seedDispatched(h: ReturnType<typeof createLogisticsHarness>): void {
  h.fulfillmentRepository.seed({
    id: "f-1",
    orderId: "order-1",
    trackingNumber: "TRK-1",
    providerShipmentId: "SB-123",
    status: "dispatched",
    courier: "DHL",
  });
}

describe("L6 Part 3 — logistics worker consumer", () => {
  it("never fabricates a fulfillment and never creates a shipment from a webhook", async () => {
    const h = createLogisticsHarness();
    const event = buildLogisticsEvent({ providerShipmentId: "SB-UNKNOWN" });

    await expect(() =>
      h.processCourierTrackingEvent.execute({ logisticsEvent: event }),
    ).rejectsWithCode("LOGISTICS_EVENT_FULFILLMENT_NOT_FOUND");

    // No fulfillment row is invented, and no provider create request is issued.
    expect(h.fulfillmentRepository.all).toHaveLength(0);
    expect(h.logisticsService.labelRequests).toHaveLength(0);
  });

  it("is idempotent: a duplicate delivery event collapses to ignored_stale", async () => {
    const h = createLogisticsHarness();
    seedDispatched(h);
    const event = buildLogisticsEvent({
      eventKey: "shipbubble:evt-dlv-1",
      eventType: "delivery.completed",
      status: "delivered",
      occurredAt: T1,
    });

    const first = await h.processCourierTrackingEvent.execute({
      logisticsEvent: event,
    });
    expect(first.outcome).toBe("processed");
    expect(first.trackingState).toBe("delivered");
    expect(first.changed).toBe(true);

    const second = await h.processCourierTrackingEvent.execute({
      logisticsEvent: event,
    });
    expect(second.outcome).toBe("ignored_stale");
    expect(second.changed).toBe(false);
    expect(second.trackingState).toBe("delivered");
    expect(h.auditLogService.actions().includes("LOGISTICS_EVENT_IGNORED_STALE")).toBe(true);
  });

  it("drops a stale event older than the stored tracking update", async () => {
    const h = createLogisticsHarness();
    h.fulfillmentRepository.seed({
      id: "f-1",
      orderId: "order-1",
      trackingNumber: "TRK-1",
      providerShipmentId: "SB-123",
      status: "dispatched",
      metadata: {
        tracking: {
          status: "in_transit",
          updatedAt: T2,
          eventKey: "shipbubble:evt-later",
        },
      },
    });

    const result = await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventKey: "shipbubble:evt-old",
        eventType: "delivery.completed",
        status: "delivered",
        occurredAt: T1,
      }),
    });
    expect(result.outcome).toBe("ignored_stale");
    expect(result.changed).toBe(false);
    expect(result.trackingState).toBe("in_transit");
  });

  it("rejects an impossible delivered -> in_transit regression terminally", async () => {
    const h = createLogisticsHarness();
    h.fulfillmentRepository.seed({
      id: "f-1",
      orderId: "order-1",
      trackingNumber: "TRK-1",
      providerShipmentId: "SB-123",
      status: "dispatched",
      metadata: {
        tracking: {
          status: "delivered",
          updatedAt: T1,
          eventKey: "shipbubble:evt-dlv-1",
        },
      },
    });

    await expect(() =>
      h.processCourierTrackingEvent.execute({
        logisticsEvent: buildLogisticsEvent({
          eventKey: "shipbubble:evt-in-transit",
          eventType: "tracking.status_changed",
          status: "in_transit",
          occurredAt: T2,
        }),
      }),
    ).rejectsWithCode("INVALID_STATUS_TRANSITION");
  });

  it("acknowledges unknown event types without crashing or changing state", async () => {
    const h = createLogisticsHarness();
    seedDispatched(h);

    const result = await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventType: "unknown",
        status: null,
        occurredAt: null,
      }),
    });
    expect(result.outcome).toBe("ignored_unknown");
    expect(result.changed).toBe(false);
    expect(h.auditLogService.actions().includes("LOGISTICS_EVENT_IGNORED_UNKNOWN")).toBe(true);
  });
});

describe("L6 Part 3 — dispatch and tracking axes are independent", () => {
  it("authoritative provider evidence resolves requires_reconciliation -> dispatched", async () => {
    const h = createLogisticsHarness();
    h.fulfillmentRepository.seed({
      id: "f-1",
      orderId: "order-1",
      trackingNumber: "TRK-1",
      providerShipmentId: "SB-123",
      status: "requires_reconciliation",
    });

    const result = await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventKey: "shipbubble:evt-dlv-1",
        eventType: "delivery.completed",
        status: "delivered",
        occurredAt: T1,
      }),
    });
    expect(result.dispatchState).toBe("dispatched");
    expect(result.trackingState).toBe("delivered");

    const saved = h.fulfillmentRepository.all[0];
    expect(saved.status).toBe("dispatched");
  });

  it("a terminally failed dispatch stays failed while tracking still progresses", async () => {
    const h = createLogisticsHarness();
    h.fulfillmentRepository.seed({
      id: "f-1",
      orderId: "order-1",
      trackingNumber: "TRK-1",
      providerShipmentId: "SB-123",
      status: "failed",
    });

    const result = await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventKey: "shipbubble:evt-dlv-1",
        eventType: "delivery.completed",
        status: "delivered",
        occurredAt: T1,
      }),
    });
    expect(result.dispatchState).toBe("failed");
    expect(result.trackingState).toBe("delivered");

    const saved = h.fulfillmentRepository.all[0];
    expect(saved.status).toBe("failed");
  });

  it("an already-dispatched shipment stays dispatched while tracking progresses", async () => {
    const h = createLogisticsHarness();
    seedDispatched(h);

    const result = await h.processCourierTrackingEvent.execute({
      logisticsEvent: buildLogisticsEvent({
        eventKey: "shipbubble:evt-dlv-1",
        eventType: "delivery.completed",
        status: "delivered",
        occurredAt: T1,
      }),
    });
    expect(result.dispatchState).toBe("dispatched");
    expect(result.trackingState).toBe("delivered");

    const saved = h.fulfillmentRepository.all[0];
    expect(saved.status).toBe("dispatched");
  });
});

describe("L6 Part 3 — domain state machines", () => {
  it("courier tracking: forward progress is legal, delivered is terminal", () => {
    expect(CourierTrackingStateMachine.next("in_transit", "out_for_delivery")).toBe(
      "out_for_delivery",
    );
    expect(CourierTrackingStateMachine.next("out_for_delivery", "delivered")).toBe(
      "delivered",
    );
    // Same-state events are idempotent.
    expect(CourierTrackingStateMachine.next("delivered", "delivered")).toBe(
      "delivered",
    );
    expect(CourierTrackingStateMachine.isTerminal("delivered")).toBe(true);
    expect(CourierTrackingStateMachine.isTerminal("in_transit")).toBe(false);

    // A delivered shipment can never move backwards.
    expect(() =>
      CourierTrackingStateMachine.next("delivered", "in_transit"),
    ).toThrowWithCode("INVALID_STATUS_TRANSITION");
    expect(() =>
      CourierTrackingStateMachine.next("delivered", "out_for_delivery"),
    ).toThrowWithCode("INVALID_STATUS_TRANSITION");
  });

  it("dispatch: terminal states never allow another automatic create attempt", () => {
    expect(DispatchStateMachine.next("dispatch_pending", "confirmed")).toBe(
      "dispatched",
    );
    expect(DispatchStateMachine.next("dispatch_pending", "ambiguous")).toBe(
      "requires_reconciliation",
    );
    expect(DispatchStateMachine.next("dispatch_pending", "rejected")).toBe("failed");
    // The ONLY webhook exit from requires_reconciliation.
    expect(
      DispatchStateMachine.next("requires_reconciliation", "confirmed_by_tracking"),
    ).toBe("dispatched");

    expect(DispatchStateMachine.isTerminal("dispatched")).toBe(true);
    expect(DispatchStateMachine.isTerminal("requires_reconciliation")).toBe(true);
    expect(DispatchStateMachine.isTerminal("failed")).toBe(true);
    expect(DispatchStateMachine.mayStartAttempt("not_attempted")).toBe(true);
    expect(DispatchStateMachine.mayStartAttempt("failed")).toBe(false);

    // A terminal state can never start a fresh automatic attempt.
    expect(() =>
      DispatchStateMachine.next("failed", "attempt_started"),
    ).toThrowWithCode("INVALID_STATE");
    expect(() =>
      DispatchStateMachine.next("dispatched", "attempt_started"),
    ).toThrowWithCode("INVALID_STATE");
  });
});