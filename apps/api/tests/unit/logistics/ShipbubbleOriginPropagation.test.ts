// apps/api/tests/unit/logistics/ShipbubbleOriginPropagation.test.ts
//
// L9 PART 28 — LOGISTICS REGRESSION: the Shipbubble adapter uses the
// APPLICATION-selected origin and never independently chooses another.
//
// The frozen `ShipmentOrigin` on `ShippingLabelRequest` comes from
// `Order.sourcingSnapshot.origin` — the LOCAL InventoryLocation sender record.
// The adapter must:
//   1. Validate the frozen origin (fail closed on a corrupted snapshot) and
//      use it as authoritative historical context.
//   2. NEVER serialize its own sender/origin into the label-create request:
//      the create body is token-bound ({request_token, service_code,
//      courier_id}) — the courier and service come VERBATIM from the frozen
//      selection, so the adapter cannot re-choose an origin/courier.
//   3. For rates, use the FIXED configured sender address — a construction-time
//      configuration value, never a per-request decision.
//   4. Accept a legacy order with no origin (null) — the app never invents one.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import {
  ShipbubbleLogisticsService,
  ShipbubbleLogisticsError,
  type ShipbubbleHttpClient,
} from "@api/infrastructure/services/ShipbubbleLogisticsService";
import { NoopLogger } from "../../fakes/NoopLogger";
import type { ShippingLabelRequest } from "@api/domain/shared/contracts";
import type { Cart } from "@api/domain/entities/Cart";
import { buildCheckoutCart } from "../../fixtures/cartFactory";

interface CapturedRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** Minimal JSON HTTP response (Node 18+ global Response). */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CONFIGURED_SENDER = {
  name: "Origin Studio Lagos",
  email: "origin@originstudio.test",
  phone: "+2348000000000",
  address: "12 Marina Road, Lagos Island, Lagos",
};

const FROZEN_ORIGIN = {
  locationId: "loc-lagos",
  name: "Origin Studio Lagos",
  email: "origin@originstudio.test",
  phone: "+2348000000000",
  address: "12 Marina Road, Lagos Island, Lagos",
  providerAddressCode: null,
};

function buildLabelRequest(
  overrides: Partial<ShippingLabelRequest> = {},
): ShippingLabelRequest {
  return {
    orderId: "order-1",
    requestToken: "token-1",
    selection: {
      quoteId: "quote-1",
      courierId: "courier-7",
      serviceCode: "SC-EXPRESS",
      serviceLevel: "Express",
      amountMinor: 2500,
      currency: "ngn",
      etaDays: 3,
    },
    destination: {
      name: "Ada Okafor",
      email: "buyer@example.com",
      phone: "+2348000000000",
      line1: "1 Marina Street",
      city: "Lagos",
      state: "Lagos",
      postalCode: "101001",
      countryCode: "NG",
    },
    parcelItems: [
      {
        lineItemId: "line-1",
        title: "Classic Tee",
        quantity: 2,
        unitPriceMinor: 25000,
        weightKg: null,
      },
    ],
    dimensions: { length: 10, width: 10, height: 10 },
    origin: FROZEN_ORIGIN,
    ...overrides,
  };
}

function buildService(requests: CapturedRequest[]): ShipbubbleLogisticsService {
  const httpClient: ShipbubbleHttpClient = async (url, init) => {
    const body = init.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    requests.push({ url, method: String(init.method ?? "GET"), body });

    if (url.endsWith("/v1/shipping/labels")) {
      return jsonResponse({ status: "success", data: { order_id: "SB-1" } });
    }
    if (url.includes("/v1/shipping/labels/list/")) {
      return jsonResponse({
        status: "success",
        data: {
          results: [
            {
              order_id: "SB-1",
              courier: { tracking_code: "TRK-1", name: "DHL" },
              waybill_document: null,
            },
          ],
        },
      });
    }
    if (url.endsWith("/v1/shipping/address/validate")) {
      return jsonResponse({ status: "success", data: { address_code: 111 } });
    }
    if (url.endsWith("/v1/shipping/fetch_rates")) {
      return jsonResponse({
        status: "success",
        data: {
          request_token: "rates-token-1",
          couriers: [
            {
              courier_id: "courier-7",
              service_code: "SC-EXPRESS",
              rate_card_amount: 2500,
              currency: "NGN",
            },
          ],
        },
      });
    }
    return jsonResponse(
      { status: "failed", message: `unexpected ${url}` },
      404,
    );
  };

  return new ShipbubbleLogisticsService({
    apiKey: "sb_test_key",
    logger: new NoopLogger(),
    senderAddress: CONFIGURED_SENDER,
    packageCategoryId: 1,
    httpClient,
  });
}

describe("PART 28 — the adapter uses the selected origin and never chooses another", () => {
  it("the label-create body is token-bound and carries NO adapter-chosen origin or sender", async () => {
    const requests: CapturedRequest[] = [];
    const service = buildService(requests);

    const result = await service.createShippingLabel(buildLabelRequest());

    // The frozen origin from the order is authoritative historical context
    // (validated), and the create body is EXACTLY the frozen selection — the
    // adapter serializes no sender/origin of its own choosing.
    const create = requests.find((r) => r.url.endsWith("/v1/shipping/labels"));
    expect(create).toBeDefined();
    expect(create!.body).toEqual({
      request_token: "token-1",
      service_code: "SC-EXPRESS",
      courier_id: "courier-7",
    });
    // No origin, no sender address, no sender_address_code ever leak into the
    // label-create payload — the adapter cannot re-choose a shipping origin.
    expect(JSON.stringify(create!.body)).not.toContain("origin");
    expect(JSON.stringify(create!.body)).not.toContain("sender");
    expect(JSON.stringify(create!.body)).not.toContain("address");

    expect(result.providerShipmentId).toBe("SB-1");
  });

  it("a malformed frozen origin fails CLOSED with INVALID_PAYLOAD", async () => {
    const requests: CapturedRequest[] = [];
    const service = buildService(requests);

    // Corrupted snapshot: no locationId — the adapter must NOT proceed with a
    // half-understood origin. The adapter surfaces a classified RepositoryError
    // (code UNKNOWN, category INVALID_PAYLOAD); the dispatch use case maps it
    // onto a stable domain code.
    let first: unknown;
    try {
      await service.createShippingLabel(
        buildLabelRequest({
          origin: {
            locationId: "",
            name: "Origin Studio Lagos",
            email: "origin@originstudio.test",
            phone: "+2348000000000",
            address: "12 Marina Road, Lagos Island, Lagos",
          },
        }),
      );
    } catch (err) {
      first = err;
    }
    expect(first).toBeInstanceOf(ShipbubbleLogisticsError);
    expect(
      (first as ShipbubbleLogisticsError).category,
    ).toBe("INVALID_PAYLOAD");

    await expect(() =>
      service.createShippingLabel(
        buildLabelRequest({
          origin: {
            locationId: "loc-lagos",
            name: "",
            email: "",
            phone: "",
            address: "",
          },
        }),
      ),
    ).rejectsWithCode("UNKNOWN");

    // The provider was never contacted for a corrupted origin.
    expect(requests).toHaveLength(0);
  });

  it("a legacy order with no origin is accepted (the app never invents one)", async () => {
    const requests: CapturedRequest[] = [];
    const service = buildService(requests);

    const result = await service.createShippingLabel(
      buildLabelRequest({ origin: null }),
    );
    expect(result.providerShipmentId).toBe("SB-1");
    const create = requests.find((r) => r.url.endsWith("/v1/shipping/labels"));
    expect(create!.body).toEqual({
      request_token: "token-1",
      service_code: "SC-EXPRESS",
      courier_id: "courier-7",
    });
  });

  it("rates use the FIXED configured sender address — never a per-request origin decision", async () => {
    const requests: CapturedRequest[] = [];
    const service = buildService(requests);

    const cart = buildCheckoutCart({ id: "cart-1" }) as Cart;
    const quotes = await service.fetchDynamicRates(cart);
    expect(quotes).toHaveLength(1);

    // The validated sender is the construction-time configuration — the
    // adapter never re-derives an origin from the request/order.
    const validate = requests.find((r) =>
      r.url.endsWith("/v1/shipping/address/validate"),
    );
    expect(validate).toBeDefined();
    expect(validate!.body).toEqual({
      name: CONFIGURED_SENDER.name,
      email: CONFIGURED_SENDER.email,
      phone: CONFIGURED_SENDER.phone,
      address: CONFIGURED_SENDER.address,
    });

    // The rates request carries the CONFIGURED sender address code, not a
    // request-chosen origin.
    const rates = requests.find((r) =>
      r.url.endsWith("/v1/shipping/fetch_rates"),
    );
    expect((rates!.body!["sender_address_code"] as number) ?? null).toBe(111);
  });

  it("a rejected origin type is never coerced silently", async () => {
    const requests: CapturedRequest[] = [];
    const service = buildService(requests);
    let thrown: unknown;
    try {
      await service.createShippingLabel(
        buildLabelRequest({
          origin: 42 as unknown as ShippingLabelRequest["origin"],
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ShipbubbleLogisticsError);
    expect((thrown as { code?: string }).code).toBe("UNKNOWN");
    expect(requests).toHaveLength(0);
  });
});