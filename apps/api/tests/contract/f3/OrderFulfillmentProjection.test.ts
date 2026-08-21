// apps/api/tests/contract/f3/OrderFulfillmentProjection.test.ts
//
// ORDER PROJECTION — DATA-LEAK GUARD (F3.5 audit).
//
// The Order entity's `fulfillments` column carries the DURABLE dispatch
// markers written by DispatchOrderFulfillmentUseCase. Those markers are
// provider-rich: `providerShipmentId` (top level), `sourcingLocationId`, and
// `metadata.dispatchAttempt.{requestToken, courierId, serviceCode,
// providerShipmentId}` — none of which the OpenAPI `Fulfillment` schema
// declares. The HTTP projection (`toOrderResponse` -> `toFulfillmentResponse`)
// must reduce each marker to EXACTLY the declared fields and strip the
// provider-only metadata keys (recursively).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { Order } from "@api/domain/entities/Order";
import { toOrderResponse } from "@api/adapters/http/projections";

const PROVIDER_ONLY_KEYS = [
  "providerShipmentId",
  "requestToken",
  "courierId",
  "serviceCode",
  "sourcingLocationId",
  "dispatchAttempt",
];

/**
 * Assert that none of the provider-only keys appear anywhere in a serialized
 * JSON payload — not as a top-level fulfillment field and not nested inside the
 * declared `metadata` object.
 */
function expectNoProviderOnlyKeys(value: unknown): void {
  const json = JSON.stringify(value);
  for (const key of PROVIDER_ONLY_KEYS) {
    expect(json.includes(`"${key}"`)).toBe(false);
  }
}

/** Build a faithfully-shaped order whose fulfillments carry a dispatched marker. */
function buildDispatchedOrder(): Order {
  return new Order({
    id: "order-1",
    cartId: "cart-1",
    customerId: "customer-1",
    totalAmountMinor: 12500,
    currency: "ngn",
    subtotalMinor: 10000,
    discountMinor: 0,
    taxMinor: 750,
    shippingMinor: 1750,
    insuranceMinor: 0,
    fulfillmentStatus: "fulfilled",
    paymentStatus: "captured",
    transactionReference: "pay-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    lineItems: [
      {
        id: "line-1",
        variantId: "variant-1",
        quantity: 1,
        unitPriceMinor: 10000,
        fulfilledQuantity: 1,
      },
    ],
    availableVariants: [{ id: "variant-1", unitPriceMinor: 10000 }],
    fulfillments: [
      {
        id: "fulfillment-1",
        orderId: "order-1",
        trackingNumber: "NG-123456",
        status: "dispatched",
        providerShipmentId: "shipbubble-abc-123",
        sourcingLocationId: "loc-lagos-01",
        labelUrl: "https://labels.example.com/fulfillment-1",
        courier: "GIG Logistics",
        serviceLevel: "standard",
        createdAt: "2026-08-02T00:00:00.000Z",
        metadata: {
          dispatchAttempt: {
            requestedAt: "2026-08-02T00:00:00.000Z",
            state: "confirmed",
            requestToken: "rt-secret-token",
            courierId: "gig",
            serviceCode: "standard",
            outcome: "confirmed",
            providerShipmentId: "shipbubble-abc-123",
            confirmedAt: "2026-08-02T00:00:01.000Z",
          },
        },
      },
    ],
    pendingReturns: [],
  });
}

describe("order projection — no provider-only fulfillment leaks", () => {
  it("exposes ONLY the OpenAPI Fulfillment-declared fields for a dispatched order", () => {
    const response = toOrderResponse(buildDispatchedOrder());

    expect(response.fulfillments).toHaveLength(1);
    const fulfillment = response.fulfillments[0];

    // Declared fields survive with their values.
    expect(fulfillment).toEqual({
      id: "fulfillment-1",
      orderId: "order-1",
      trackingNumber: "NG-123456",
      courier: "GIG Logistics",
      labelUrl: "https://labels.example.com/fulfillment-1",
      serviceLevel: "standard",
      status: "dispatched",
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    // Provider-only keys are absent at every depth (top level + metadata).
    expectNoProviderOnlyKeys(response);
  });

  it("preserves the declared metadata when it carries no provider-only keys", () => {
    const order = buildDispatchedOrder();
    (order.fulfillments as Array<Record<string, unknown>>)[0].metadata = {
      dispatchNote: "held at depot after first attempt",
    };

    const response = toOrderResponse(order);
    const fulfillment = response.fulfillments[0];
    expect(fulfillment.metadata).toEqual({
      dispatchNote: "held at depot after first attempt",
    });
    expectNoProviderOnlyKeys(response);
  });

  it("strips provider-only keys nested inside array metadata", () => {
    const order = buildDispatchedOrder();
    (order.fulfillments as Array<Record<string, unknown>>)[0].metadata = {
      events: [
        { courierId: "gig", note: "picked up" },
        { serviceCode: "standard", note: "in transit" },
      ],
    };

    const response = toOrderResponse(order);
    const fulfillment = response.fulfillments[0];
    expect(fulfillment.metadata).toEqual({
      events: [{ note: "picked up" }, { note: "in transit" }],
    });
    expectNoProviderOnlyKeys(response);
  });
});