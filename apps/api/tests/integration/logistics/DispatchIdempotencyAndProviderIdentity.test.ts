// apps/api/tests/integration/logistics/DispatchIdempotencyAndProviderIdentity.test.ts
//
// L6 Part 3 — shipment dispatch idempotency + provider identity.
//
// Proves DispatchOrderFulfillmentUseCase creates EXACTLY ONE provider shipment:
//   - the label request is built VERBATIM from the frozen shipping snapshot;
//   - a duplicate dispatch never issues a second POST (either the order is
//     already fulfilled, or an existing provider shipment id is replayed);
//   - a definite rejection records `failed` and is never re-attempted;
//   - a timeout/network ambiguity records `requires_reconciliation` and is
//     NEVER blindly retried (rehydration carries the durable marker);
//   - the provider shipment id is a first-class external identity, never the
//     application orderId — and cancellation is addressed by it.

import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import {
  buildDispatchableOrder,
  createLogisticsHarness,
} from "./logisticsHarness";
import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";

describe("L6 Part 3 — dispatch idempotency & provider identity", () => {
  it("dispatches from the frozen snapshot exactly once and persists provider identity", async () => {
    const h = createLogisticsHarness();
    const result = await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });

    expect(result.dispatchState).toBe("dispatched");
    expect(result.providerShipmentId).toBe("SB-ORDER-1");
    expect(result.replayed).toBe(false);

    // The provider received EXACTLY ONE create request, built verbatim from the
    // frozen snapshot — never re-fetched rates, never today's cart.
    expect(h.logisticsService.labelRequests).toHaveLength(1);
    const request = h.logisticsService.labelRequests[0];
    expect(request.orderId).toBe("order-1");
    expect(request.requestToken).toBe("request-token-1");
    expect(request.selection.quoteId).toBe("quote-1");
    expect(request.selection.courierId).toBe("courier-1");
    expect(request.selection.serviceCode).toBe("SC-EXPRESS");
    expect(request.selection.amountMinor).toBe(2500);
    expect(request.selection.currency).toBe("ngn");
    expect(request.destination.name).toBe("Ada Okafor");
    expect(request.destination.email).toBe("buyer@example.com");
    expect(request.parcelItems).toHaveLength(2);

    // The durable fulfillment row carries the dispatch state + provider facts.
    expect(h.fulfillmentRepository.all).toHaveLength(1);
    const fulfillment = h.fulfillmentRepository.all[0];
    expect(fulfillment.status).toBe("dispatched");
    expect(fulfillment.providerShipmentId).toBe("SB-ORDER-1");
    expect(fulfillment.trackingNumber).toBe("TRK-ORDER-1");
    expect(fulfillment.courier).toBe("DHL");

    // The order is marked fulfilled and the dispatch audited.
    expect(h.order.fulfillmentStatus).toBe("fulfilled");
    expect(h.auditLogService.actions().includes("ORDER_DISPATCHED")).toBe(true);

    // The provider shipment id is a first-class provider identity — never the
    // application orderId — and is the authoritative cross-boundary reference.
    expect(fulfillment.providerShipmentId).not.toBe("order-1");
    const byProvider = await h.fulfillmentRepository.findByProviderShipmentId(
      "SB-ORDER-1",
    );
    expect(byProvider?.orderId).toBe("order-1");
    expect(await h.fulfillmentRepository.findByProviderShipmentId("order-1")).toBeNull();
  });

  it("a duplicate dispatch after success never issues a second POST", async () => {
    const h = createLogisticsHarness();
    await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });

    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("INVALID_STATE");

    // Exactly ONE provider shipment was created.
    expect(h.logisticsService.labelRequests).toHaveLength(1);
    expect(h.fulfillmentRepository.all).toHaveLength(1);
  });

  it("an existing provider shipment id is replayed idempotently — zero POSTs", async () => {
    const existing = {
      id: "f-1",
      orderId: "order-1",
      trackingNumber: "TRK-ORDER-1",
      providerShipmentId: "SB-ORDER-1",
      status: "dispatched",
      courier: "DHL",
    };
    const h = createLogisticsHarness({
      order: buildDispatchableOrder({
        fulfillmentStatus: "unfulfilled",
        fulfillments: [existing],
      }),
    });
    h.fulfillmentRepository.seed(existing);

    const result = await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });
    expect(result.replayed).toBe(true);
    expect(result.providerShipmentId).toBe("SB-ORDER-1");
    expect(result.dispatchState).toBe("dispatched");

    // The shipment EXISTS at the provider: replay, never a create POST.
    expect(h.logisticsService.labelRequests).toHaveLength(0);
    expect(h.auditLogService.actions().includes("ORDER_DISPATCH_REPLAYED")).toBe(true);
  });

  it("a definite rejection records failed and is never automatically re-attempted", async () => {
    const h = createLogisticsHarness();
    h.logisticsService.failCreateWithCode = RepositoryErrorCode.UNKNOWN;

    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("EXTERNAL_SERVICE_ERROR");

    expect(h.fulfillmentRepository.all[0].status).toBe("failed");
    expect(h.order.fulfillmentStatus).toBe("unfulfilled");
    expect(h.auditLogService.actions().includes("ORDER_DISPATCH_FAILED")).toBe(true);

    // Rehydrate the order with the durable failed marker: a later attempt is a
    // hard INVALID_OPERATION — the provider definitively rejected the create.
    const rehydrated = buildDispatchableOrder({
      fulfillments: h.fulfillmentRepository.all,
    });
    h.orderRepository.seed(rehydrated);
    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("INVALID_OPERATION");
    expect(h.logisticsService.labelRequests).toHaveLength(1);
  });

  it("a timeout is ambiguous: persists requires_reconciliation and NEVER blindly retries", async () => {
    const h = createLogisticsHarness();
    h.logisticsService.failCreateWithCode = RepositoryErrorCode.TIMEOUT;

    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("SHIPMENT_REQUIRES_RECONCILIATION");

    expect(h.fulfillmentRepository.all[0].status).toBe("requires_reconciliation");
    expect(h.order.fulfillmentStatus).toBe("unfulfilled");
    expect(h.auditLogService.actions().includes("ORDER_DISPATCH_REQUIRES_RECONCILIATION")).toBe(
      true,
    );

    // Rehydrate the order with the durable ambiguous marker: the next attempt
    // REFUSES to create another shipment — the provider may hold one.
    const rehydrated = buildDispatchableOrder({
      fulfillments: h.fulfillmentRepository.all,
    });
    h.orderRepository.seed(rehydrated);
    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("SHIPMENT_REQUIRES_RECONCILIATION");
    expect(h.logisticsService.labelRequests).toHaveLength(1);
  });

  it("a persistence failure AFTER provider creation is requires_reconciliation with the provider id", async () => {
    const h = createLogisticsHarness();
    // The claim insert + provider POST succeed; the ORDER save inside the
    // confirm transaction fails, leaving the provider holding a shipment that
    // the application can no longer durably describe.
    h.orderRepository.failNextSaveWith = RepositoryErrorCode.UNKNOWN;

    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("SHIPMENT_REQUIRES_RECONCILIATION");

    // The provider holds a shipment (SB-ORDER-1) that could not be durably
    // confirmed: the marker carries the provider id. No cancel is issued — the
    // shipment exists. (The seeded in-memory aggregate was mutated in memory
    // before the failing save, so durable order state is asserted via a fresh
    // rehydration instead.)
    expect(h.fulfillmentRepository.all[0].status).toBe("requires_reconciliation");
    expect(h.fulfillmentRepository.all[0].providerShipmentId).toBe("SB-ORDER-1");
    expect(h.logisticsService.cancellations).toHaveLength(0);
    expect(h.auditLogService.actions().includes("ORDER_DISPATCH_REQUIRES_RECONCILIATION")).toBe(
      true,
    );

    // Rehydrate the durable order: it refuses to create ANOTHER shipment —
    // the provider already holds SB-ORDER-1.
    const rehydrated = buildDispatchableOrder({
      fulfillments: h.fulfillmentRepository.all,
    });
    h.orderRepository.seed(rehydrated);
    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("SHIPMENT_REQUIRES_RECONCILIATION");
    expect(h.logisticsService.labelRequests).toHaveLength(1);
  });

  it("a malformed provider result is treated as ambiguous, never as success", async () => {
    const h = createLogisticsHarness();
    h.logisticsService.labelResult = {
      providerShipmentId: "SB-X",
      trackingNumber: "",
    };

    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("SHIPMENT_REQUIRES_RECONCILIATION");
    expect(h.fulfillmentRepository.all[0].status).toBe("requires_reconciliation");
    expect(h.order.fulfillmentStatus).toBe("unfulfilled");
  });

  it("dispatch fails closed when the frozen snapshot is missing", async () => {
    const h = createLogisticsHarness({
      order: buildDispatchableOrder({ shippingSnapshot: null }),
    });
    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("INVALID_STATE");
    expect(h.logisticsService.labelRequests).toHaveLength(0);
  });

  it("an already-fulfilled order is never dispatched again", async () => {
    const h = createLogisticsHarness({
      order: buildDispatchableOrder({ fulfillmentStatus: "fulfilled" }),
    });
    await expect(() =>
      h.dispatchOrderFulfillment.execute({ orderId: "order-1" }),
    ).rejectsWithCode("INVALID_STATE");
    expect(h.logisticsService.labelRequests).toHaveLength(0);
  });

  it("cancellation is addressed by the provider shipment id, never the orderId", async () => {
    const h = createLogisticsHarness();
    await h.dispatchOrderFulfillment.execute({ orderId: "order-1" });

    await h.logisticsService.cancelFulfillment("order-1", {
      providerShipmentId: "SB-ORDER-1",
      trackingNumber: "TRK-ORDER-1",
    });

    expect(h.logisticsService.cancellations).toHaveLength(1);
    const cancellation = h.logisticsService.cancellations[0];
    expect(cancellation.reference.providerShipmentId).toBe("SB-ORDER-1");
    expect(cancellation.reference.providerShipmentId).not.toBe("order-1");
    expect(cancellation.orderId).toBe("order-1");
  });
});