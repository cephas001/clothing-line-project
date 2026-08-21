// apps/api/tests/contract/f3/F3Routers.test.ts
//
// HTTP CONTRACT TESTS — the F3 router adapters (carts, customers, orders,
// admin, courier-tracking webhook).
//
// The transport boundary must:
//   - accept ONLY the declared body keys (additionalProperties: false); a
//     client-supplied identity / amount / financial field is rejected with 400
//     BEFORE the use case runs.
//   - never accept a customerId from the body on /me routes — the bearer JWT is
//     the only identity source; a body identity that differs from the token is
//     PERMISSION_DENIED (403).
//   - require a valid bearer token on every /admin/* and /store/customers/me/*
//     route (401 when missing).
//   - gate optional routes on wired use cases: when the use case is absent the
//     route is NOT registered and requests receive 404 (never faked).
//   - keep the courier-tracking webhook a pure verify-signature -> parse+map ->
//     enqueue boundary (204, no fulfillment mutation, fail-closed 401 on a
//     missing/mismatched signature).
//   - never echo stack traces, tokens, or provider internals.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import express, { Express } from "express";
import type { AddressInfo } from "node:net";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { FakeTokenService } from "../../fakes/FakeTokenService";
import { NoopLogger } from "../../fakes/NoopLogger";
import { createCartRouter } from "@api/adapters/http/routers/CartRouter";
import { createCustomersRouter } from "@api/adapters/http/routers/CustomersRouter";
import { createOrdersRouter } from "@api/adapters/http/routers/OrdersRouter";
import { createAdminRouter } from "@api/adapters/http/routers/AdminRouter";
import { createCourierTrackingWebhookRouter } from "@api/adapters/http/routers/CourierTrackingWebhookRouter";
import { CourierTrackingWebhookPayloadMapper } from "@api/infrastructure/services/CourierTrackingWebhookPayloadMapper";

interface ServerHandle {
  baseUrl: string;
  close(): Promise<void>;
}

function startServer(app: Express): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
    server.once("error", reject);
  });
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function send(
  baseUrl: string,
  method: "POST" | "PUT" | "GET" | "DELETE",
  path: string,
  body?: unknown,
  bearer?: string,
  extraHeaders: Record<string, string> = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { __nonJson: true };
    }
  }
  return { status: response.status, body: parsed };
}

/** Minimal Cart entity shape the public projection reads (plain accessors). */
function fakeCart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cart-1",
    regionId: "region-1",
    salesChannelId: "channel-1",
    customerId: null,
    email: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    countryCode: null,
    shippingAddress: null,
    taxAmountMinor: null,
    metadata: {},
    frozen: false,
    frozenReason: null,
    frozenAt: null,
    orderId: null,
    convertedAt: null,
    status: "active",
    paymentStatus: "uninitialized",
    paymentInitialized: false,
    paymentAuthorizationUrl: null,
    paymentInitializedAt: null,
    cartTotalMinor: 0,
    items: [],
    appliedPromotion: null,
    ...overrides,
  };
}

/** Minimal Customer entity shape the public projection reads. */
function fakeCustomer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "customer-1",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    activeCartId: null,
    registeredAt: "2026-08-20T00:00:00.000Z",
    phone: null,
    addresses: [],
    disabled: false,
    roles: [],
    metadata: {},
    ...overrides,
  };
}

/** Minimal Product entity shape the public projection reads. */
function fakeProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "product-1",
    title: "Shirt",
    handle: "shirt",
    description: null,
    variants: [],
    categoryIds: [],
    media: [],
    ...overrides,
  };
}

const VALID_CLAIMS = {
  customerId: "customer-1",
  email: "buyer@example.com",
  roles: [],
};

function tokenService(): FakeTokenService {
  return new FakeTokenService(new Map([["valid-token", VALID_CLAIMS]]));
}

/** Stub factory for use cases that must never be reached by a test. */
function unreachable(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`${name} should not be invoked.`);
  };
}

describe("F3 — cart router transport boundary", () => {
  function buildApp(): Express {
    const app = express();
    app.use(
      "/store/carts",
      createCartRouter({
        initializeCartSession: {
          async execute(input: { regionId: string; salesChannelId: string }) {
            return fakeCart() as never;
          },
        } as never,
        getCart: { execute: unreachable("getCart") } as never,
        addCustomLineItem: { execute: unreachable("addCustomLineItem") } as never,
        updateLineItemQuantity: {
          execute: unreachable("updateLineItemQuantity"),
        } as never,
        removeCartLineItem: {
          execute: unreachable("removeCartLineItem"),
        } as never,
        applyDiscountCode: {
          execute: unreachable("applyDiscountCode"),
        } as never,
        mergeGuestCartToCustomer: {
          execute: unreachable("mergeGuestCartToCustomer"),
        } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("200 with the cart projection for valid initialize input", async () => {
    const server = await startServer(buildApp());
    try {
      const response = await send(server.baseUrl, "POST", "/store/carts", {
        regionId: "region-1",
        salesChannelId: "channel-1",
      });
      expect(response.status).toBe(200);
      expect(response.body.id).toBe("cart-1");
      expect(response.body.regionId).toBe("region-1");
      expect(response.body.items).toEqual([]);
      expect(response.body.appliedPromotion).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a client-supplied financial/customer field", async () => {
    const server = await startServer(buildApp());
    try {
      const response = await send(server.baseUrl, "POST", "/store/carts", {
        regionId: "region-1",
        salesChannelId: "channel-1",
        totalMinor: 1,
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: 'Unexpected field "totalMinor" in request body.',
        },
      });
    } finally {
      await server.close();
    }
  });

  it("404 when the pricing-gated line-items route is unwired (never faked)", async () => {
    const server = await startServer(buildApp());
    try {
      const response = await send(server.baseUrl, "POST", "/store/carts/cart-1/line-items", {
        variantId: "v-1",
        quantity: 1,
      });
      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("F3 — customers router transport boundary", () => {
  let calls: Array<{ customerId: string; action: string }>;

  function buildApp(withToken: boolean): Express {
    calls = [];
    const app = express();
    app.use(
      "/store",
      createCustomersRouter({
        registerCustomerAccount: {
          async execute(input: { firstName: string }) {
            return fakeCustomer() as never;
          },
        } as never,
        completePasswordReset: {
          execute: unreachable("completePasswordReset"),
        } as never,
        getCustomerProfile: { execute: unreachable("getCustomerProfile") } as never,
        getCustomerAddresses: {
          execute: unreachable("getCustomerAddresses"),
        } as never,
        manageAddressBook: {
          async execute(input: {
            customerId: string;
            action: string;
          }) {
            calls.push({
              customerId: input.customerId,
              action: input.action,
            });
          },
        } as never,
        manageB2BBusinessUnit: {
          execute: unreachable("manageB2BBusinessUnit"),
        } as never,
        requestQuote: { execute: unreachable("requestQuote") } as never,
        approveB2BQuote: { execute: unreachable("approveB2BQuote") } as never,
        retrieveOrderHistory: {
          execute: unreachable("retrieveOrderHistory"),
        } as never,
        processCustomerDataErasure: {
          execute: unreachable("processCustomerDataErasure"),
        } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("201 with the customer projection for valid registration", async () => {
    const server = await startServer(buildApp(false));
    try {
      const response = await send(server.baseUrl, "POST", "/store/customers", {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        password: "secret",
      });
      expect(response.status).toBe(201);
      expect(response.body.id).toBe("customer-1");
      expect(response.body.firstName).toBe("Ada");
      expect(response.body.email).toBe("ada@example.com");
    } finally {
      await server.close();
    }
  });

  it("401 when a /me route is called without a bearer token", async () => {
    const server = await startServer(buildApp(false));
    try {
      const response = await send(server.baseUrl, "POST", "/store/customers/me/addresses", {
        street: "Main St",
      });
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("uses the JWT identity (never the body) on /me/addresses", async () => {
    const server = await startServer(buildApp(true));
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/store/customers/me/addresses",
        { street: "Main St", customerId: "customer-999" },
        "valid-token",
      );
      expect(response.status).toBe(204);
      expect(calls).toEqual([{ customerId: "customer-1", action: "add" }]);
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a non-object address body (array)", async () => {
    const server = await startServer(buildApp(true));
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/store/customers/me/addresses",
        [],
        "valid-token",
      );
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body must be a JSON object.",
        },
      });
    } finally {
      await server.close();
    }
  });
});

describe("F3 — orders router transport boundary", () => {
  function buildApp(): Express {
    const app = express();
    app.use(
      "/store",
      createOrdersRouter({
        // logistics-gated routes intentionally unwired -> 404
        getOrder: { execute: unreachable("getOrder") } as never,
        proposeOrderEdit: { execute: unreachable("proposeOrderEdit") } as never,
        confirmOrderEdit: { execute: unreachable("confirmOrderEdit") } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("404 when the logistics-gated returns route is unwired (never faked)", async () => {
    const server = await startServer(buildApp());
    try {
      const response = await send(server.baseUrl, "POST", "/store/orders/order-1/returns", {
        orderId: "order-1",
        items: [{ lineItemId: "li-1", quantity: 1, reasonCode: "wrong_size" }],
      });
      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("F3 — admin router transport boundary", () => {
  let calls: Array<{ adminId: string; title: string }>;

  function buildApp(): Express {
    calls = [];
    const app = express();
    app.use(
      "/admin",
      createAdminRouter({
        createProduct: {
          async execute(input: { adminId: string; title: string }) {
            calls.push({ adminId: input.adminId, title: input.title });
            return fakeProduct({ title: input.title }) as never;
          },
        } as never,
        createProductVariant: {
          execute: unreachable("createProductVariant"),
        } as never,
        configureRegionalPricing: {
          execute: unreachable("configureRegionalPricing"),
        } as never,
        createPromotionRule: {
          execute: unreachable("createPromotionRule"),
        } as never,
        createSalesChannel: {
          execute: unreachable("createSalesChannel"),
        } as never,
        manageCategories: {
          executeCreate: unreachable("manageCategories"),
        } as never,
        manageAdminRolePermissions: {
          execute: unreachable("manageAdminRolePermissions"),
        } as never,
        importBulkCatalogData: {
          execute: unreachable("importBulkCatalogData"),
        } as never,
        listDeadLetterJobs: {
          execute: unreachable("listDeadLetterJobs"),
        } as never,
        retryDeadLetterJob: {
          execute: unreachable("retryDeadLetterJob"),
        } as never,
        generateDraftOrder: {
          execute: unreachable("generateDraftOrder"),
        } as never,
        determineSourcingLocation: {
          execute: unreachable("determineSourcingLocation"),
        } as never,
        pruneAbandonedCarts: {
          execute: unreachable("pruneAbandonedCarts"),
        } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("401 when no bearer token is presented on /admin/*", async () => {
    const server = await startServer(buildApp());
    try {
      const response = await send(server.baseUrl, "POST", "/admin/products", {
        title: "Shirt",
        handle: "shirt",
      });
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("201 with the product projection and the token identity as adminId", async () => {
    const server = await startServer(buildApp());
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/admin/products",
        { title: "Shirt", handle: "shirt" },
        "valid-token",
      );
      expect(response.status).toBe(201);
      expect(response.body.id).toBe("product-1");
      expect(response.body.title).toBe("Shirt");
      expect(calls).toEqual([
        { adminId: "customer-1", title: "Shirt" },
      ]);
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a client-supplied adminId/amount field", async () => {
    const server = await startServer(buildApp());
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/admin/products",
        { title: "Shirt", handle: "shirt", adminId: "attacker" },
        "valid-token",
      );
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("F3 — courier-tracking webhook transport boundary", () => {
  function buildApp(
    queueExecute: (event: unknown) => Promise<void>,
    signatureHeader = "valid-signature",
  ): Express {
    const app = express();
    app.use(
      "/store/webhooks/courier-tracking",
      createCourierTrackingWebhookRouter({
        verifySignature: {
          execute(input: { signatureHeader: string }): void {
            if (input.signatureHeader !== "valid-signature") {
              throw new DomainError(
                "LOGISTICS_VERIFICATION_FAILED",
                "Signature verification failed.",
              );
            }
          },
        } as never,
        queueLogisticsEvent: { execute: queueExecute } as never,
        mapper: new CourierTrackingWebhookPayloadMapper(),
        webhookSecret: "test-secret",
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("204 and enqueues a provider-neutral event (verify->parse->map->enqueue)", async () => {
    let enqueued: unknown;
    const server = await startServer(
      buildApp(async (input) => {
        enqueued = (input as { logisticsEvent: unknown }).logisticsEvent;
      }),
    );
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/store/webhooks/courier-tracking",
        {
          trackingNumber: "TN-123",
          courierStatus: "in_transit",
          timestamp: "2026-08-20T10:00:00Z",
        },
        undefined,
        { "x-courier-signature": "valid-signature" },
      );
      expect(response.status).toBe(204);
      const event = enqueued as {
        provider: string;
        providerShipmentId: string;
        eventKey: string;
        notifyCustomer?: boolean;
      };
      expect(event.provider).toBe("courier");
      expect(event.providerShipmentId).toBe("TN-123");
      expect(event.eventKey).toContain("TN-123");
      expect(event.notifyCustomer).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("401 fail-closed when the signature is missing or mismatched (before JSON parsing)", async () => {
    const server = await startServer(buildApp(unreachable("queueLogisticsEvent")));
    try {
      const missing = await send(server.baseUrl, "POST", "/store/webhooks/courier-tracking", {
        trackingNumber: "TN-123",
        courierStatus: "in_transit",
        timestamp: "2026-08-20T10:00:00Z",
      });
      expect(missing.status).toBe(401);
      expect((missing.body.error as Record<string, unknown>).code).toBe(
        "LOGISTICS_VERIFICATION_FAILED",
      );

      const tampered = await send(
        server.baseUrl,
        "POST",
        "/store/webhooks/courier-tracking",
        {
          trackingNumber: "TN-123",
          courierStatus: "in_transit",
          timestamp: "2026-08-20T10:00:00Z",
        },
        undefined,
        { "x-courier-signature": "tampered" },
      );
      expect(tampered.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("400 for a malformed payload (missing required tracking number)", async () => {
    const server = await startServer(buildApp(unreachable("queueLogisticsEvent")));
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/store/webhooks/courier-tracking",
        {
          courierStatus: "in_transit",
          timestamp: "2026-08-20T10:00:00Z",
        },
        undefined,
        { "x-courier-signature": "valid-signature" },
      );
      expect(response.status).toBe(400);
      const error = response.body.error as Record<string, unknown>;
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message as string).toContain("trackingNumber");
    } finally {
      await server.close();
    }
  });

  it("surfaces a queue outage as a retryable 500", async () => {
    const server = await startServer(
      buildApp(async () => {
        throw new DomainError(
          "INTERNAL_ERROR",
          "Queue unavailable.",
        );
      }),
    );
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/store/webhooks/courier-tracking",
        {
          trackingNumber: "TN-123",
          courierStatus: "delivered",
          timestamp: "2026-08-20T10:00:00Z",
        },
        undefined,
        { "x-courier-signature": "valid-signature" },
      );
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Queue unavailable." },
      });
    } finally {
      await server.close();
    }
  });
});

describe("F3 — courier webhook must never mutate fulfillment (L5 CRITICAL)", () => {
  it("the router only enqueues — it never touches fulfillment state", async () => {
    let queueCalls = 0;
    const app = express();
    app.use(
      "/store/webhooks/courier-tracking",
      createCourierTrackingWebhookRouter({
        verifySignature: {
          execute(): void {
            return;
          },
        } as never,
        queueLogisticsEvent: {
          async execute() {
            queueCalls += 1;
          },
        } as never,
        mapper: new CourierTrackingWebhookPayloadMapper(),
        webhookSecret: "test-secret",
        logger: new NoopLogger(),
      }),
    );
    const server = await startServer(app);
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/store/webhooks/courier-tracking",
        {
          trackingNumber: "TN-123",
          courierStatus: "out_for_delivery",
          timestamp: "2026-08-20T11:00:00Z",
        },
        undefined,
        { "x-courier-signature": "valid-signature" },
      );
      expect(response.status).toBe(204);
      expect(queueCalls).toBe(1);
    } finally {
      await server.close();
    }
  });
});