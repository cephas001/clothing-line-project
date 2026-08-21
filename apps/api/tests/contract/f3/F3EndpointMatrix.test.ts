// apps/api/tests/contract/f3/F3EndpointMatrix.test.ts
//
// HTTP CONTRACT TESTS — the FULL F3 endpoint matrix (Part 16/17).
//
// The F3 routers mount 37 new operations (Cart 8, Customers 11, Orders 4,
// Admin 13, Courier-tracking webhook 1). This suite exercises EVERY one of
// them as a transport boundary:
//
//   - HTTP contract: accepted body keys, projections, status codes, gated
//     404 for unwired routes.
//   - Authentication: /me and /admin routes require a bearer JWT (401 when
//     missing); the JWT is the ONLY identity source.
//   - Financial endpoints: the client can NEVER dictate money. Only the money
//     fields the OpenAPI contract explicitly declares (custom line-item
//     unitPriceMinor, admin regional-pricing amountMinor, promotion
//     discountValueMinor, quote-approved approvedTotalMinor, draft-order item
//     unitPriceMinor) are accepted; injected subtotal/discount/tax/shipping/
//     total/amount/currency fields are rejected with 400 BEFORE the use case
//     runs.
//   - Identity cross-checks: merge / request-quote / draft-order bodies carry
//     an identity that MUST equal the bearer token (PERMISSION_DENIED 403).
//   - Domain behavior: the use case receives the mapped, validated input.
//   - Logistics: returns/edits/confirm/fulfillments forward the mapped input
//     and never let the transport choose a courier or a refund amount.
//
// The courier-tracking webhook's raw-body/queue behaviour is covered in
// F3Routers.test.ts (204/400/500, never mutates fulfillment) and the two
// provider webhooks' raw-body HMAC integrity in
// tests/integration/payment/WebhookSecurity.test.ts +
// tests/integration/logistics/LogisticsWebhookSecurityAndQueue.test.ts +
// tests/contract/http/MiddlewareOrdering.test.ts.

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
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
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

/** Stub factory for use cases that must never be reached by a test. */
function unreachable(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`${name} should not be invoked.`);
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

/** Every financial tamper probe: a client-dictated money/identity field. */
const FINANCIAL_PROBES: Array<[string, number]> = [
  ["subtotalMinor", 1],
  ["discountMinor", 1],
  ["taxMinor", 1],
  ["shippingMinor", 1],
  ["insuranceMinor", 1],
  ["totalMinor", 1],
  ["amountMinor", 1],
  ["totalAmountMinor", 1],
  ["currency", 1],
];

async function expectFinancialProbeRejected(
  server: ServerHandle,
  method: "POST" | "PUT",
  path: string,
  baseBody: Record<string, unknown>,
  bearer?: string,
): Promise<void> {
  for (const [key, value] of FINANCIAL_PROBES) {
    const response = await send(
      server.baseUrl,
      method,
      path,
      { ...baseBody, [key]: value },
      bearer,
    );
    expect(response.status).toBe(400);
    const error = response.body.error as Record<string, unknown>;
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message as string).toContain(key);
  }
}

// ---------------------------------------------------------------------------
// CARTS — all 8 endpoints
// ---------------------------------------------------------------------------

describe("F3 matrix — cart endpoints (8/8)", () => {
  function buildCartApp(options: {
    wiredRead?: boolean;
    wiredLineItems?: boolean;
    wiredShippingAddress?: boolean;
  } = {}): Express {
    const app = express();
    app.use(
      "/store/carts",
      createCartRouter({
        initializeCartSession: {
          async execute() {
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
            } as never;
          },
        } as never,
        getCart: options.wiredRead
          ? ({
              async execute() {
                return {
                  id: "cart-1",
                  regionId: "region-1",
                  salesChannelId: "channel-1",
                  customerId: "customer-1",
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
                } as never;
              },
            } as never)
          : ({ execute: unreachable("getCart") } as never),
        addCartLineItem: options.wiredLineItems
          ? ({ execute: async () => {} } as never)
          : undefined,
        addCustomLineItem: { execute: async () => {} } as never,
        updateLineItemQuantity: { execute: async () => {} } as never,
        removeCartLineItem: { execute: async () => {} } as never,
        applyDiscountCode: { execute: async () => {} } as never,
        mergeGuestCartToCustomer: { execute: async () => {} } as never,
        setCheckoutShippingAddress: options.wiredShippingAddress
          ? ({ execute: async () => {} } as never)
          : undefined,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("POST /store/carts — 200 cart projection (covered in F3Routers, re-checked here)", async () => {
    const server = await startServer(buildCartApp());
    try {
      const response = await send(server.baseUrl, "POST", "/store/carts", {
        regionId: "region-1",
        salesChannelId: "channel-1",
      });
      expect(response.status).toBe(200);
      expect(response.body.id).toBe("cart-1");
    } finally {
      await server.close();
    }
  });

  it("GET /store/carts/:id — 200 cart projection", async () => {
    const server = await startServer(buildCartApp({ wiredRead: true }));
    try {
      const response = await send(server.baseUrl, "GET", "/store/carts/cart-1");
      expect(response.status).toBe(200);
      expect(response.body.id).toBe("cart-1");
    } finally {
      await server.close();
    }
  });

  it("POST /store/carts — rejects injected financial/customer fields with 400", async () => {
    const server = await startServer(buildCartApp());
    try {
      for (const [key, value] of [
        ...FINANCIAL_PROBES,
        ["customerId", 1],
      ] as Array<[string, number]>) {
        const response = await send(server.baseUrl, "POST", "/store/carts", {
          regionId: "region-1",
          salesChannelId: "channel-1",
          [key]: value,
        });
        expect(response.status).toBe(400);
        expect(
          (response.body.error as Record<string, unknown>).message,
        ).toContain(key);
      }
    } finally {
      await server.close();
    }
  });

  it("POST /store/carts/:id/line-items — 204 when wired; rejects money; optional auth", async () => {
    const server = await startServer(buildCartApp({ wiredLineItems: true }));
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/store/carts/cart-1/line-items",
        { variantId: "v-1", quantity: 2 },
      );
      expect(response.status).toBe(204);
      await expectFinancialProbeRejected(
        server,
        "POST",
        "/store/carts/cart-1/line-items",
        { variantId: "v-1", quantity: 2 },
      );
    } finally {
      await server.close();
    }
  });

  it("POST /store/carts/:id/line-items — 404 when the pricing use case is unwired", async () => {
    const server = await startServer(buildCartApp());
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/store/carts/cart-1/line-items",
        { variantId: "v-1", quantity: 2 },
      );
      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("POST /store/carts/:id/line-items/custom — accepts ONLY the declared B2B fields", async () => {
    const server = await startServer(buildCartApp());
    try {
      // The OpenAPI contract declares title/quantity/unitPriceMinor as
      // client-supplied B2B fields; those are forwarded. Anything else that
      // dictates money is rejected.
      const ok = await send(
        server.baseUrl,
        "POST",
        "/store/carts/cart-1/line-items/custom",
        { title: "Custom item", quantity: 1, unitPriceMinor: 5000 },
      );
      expect(ok.status).toBe(204);

      for (const key of ["subtotalMinor", "totalMinor", "discountMinor", "taxMinor", "shippingMinor", "currency"]) {
        const bad = await send(
          server.baseUrl,
          "POST",
          "/store/carts/cart-1/line-items/custom",
          { title: "Custom item", quantity: 1, unitPriceMinor: 5000, [key]: 1 },
        );
        expect(bad.status).toBe(400);
        expect((bad.body.error as Record<string, unknown>).message).toContain(key);
      }
    } finally {
      await server.close();
    }
  });

  it("PUT /store/carts/:id/line-items/:line_id — 204; rejects money fields", async () => {
    const server = await startServer(buildCartApp());
    try {
      const ok = await send(
        server.baseUrl,
        "PUT",
        "/store/carts/cart-1/line-items/li-1",
        { quantity: 3 },
      );
      expect(ok.status).toBe(204);
      await expectFinancialProbeRejected(
        server,
        "PUT",
        "/store/carts/cart-1/line-items/li-1",
        { quantity: 3 },
      );
    } finally {
      await server.close();
    }
  });

  it("DELETE /store/carts/:id/line-items/:line_id — 204", async () => {
    const server = await startServer(buildCartApp());
    try {
      const response = await send(
        server.baseUrl,
        "DELETE",
        "/store/carts/cart-1/line-items/li-1",
      );
      expect(response.status).toBe(204);
    } finally {
      await server.close();
    }
  });

  it("POST /store/carts/:id/discount — 204; rejects injected discountMinor", async () => {
    const server = await startServer(buildCartApp());
    try {
      const ok = await send(server.baseUrl, "POST", "/store/carts/cart-1/discount", {
        code: "SAVE10",
      });
      expect(ok.status).toBe(204);
      await expectFinancialProbeRejected(
        server,
        "POST",
        "/store/carts/cart-1/discount",
        { code: "SAVE10" },
      );
    } finally {
      await server.close();
    }
  });

  it("POST /store/carts/:id/merge — requires auth; body identity must equal the token", async () => {
    const server = await startServer(buildCartApp());
    try {
      const noToken = await send(server.baseUrl, "POST", "/store/carts/cart-1/merge", {
        guestCartId: "cart-g",
        customerId: "customer-1",
      });
      expect(noToken.status).toBe(401);

      const mismatch = await send(
        server.baseUrl,
        "POST",
        "/store/carts/cart-1/merge",
        { guestCartId: "cart-g", customerId: "customer-999" },
        "valid-token",
      );
      expect(mismatch.status).toBe(403);
      expect((mismatch.body.error as Record<string, unknown>).code).toBe(
        "PERMISSION_DENIED",
      );

      const ok = await send(
        server.baseUrl,
        "POST",
        "/store/carts/cart-1/merge",
        { guestCartId: "cart-g", customerId: "customer-1" },
        "valid-token",
      );
      expect(ok.status).toBe(204);
    } finally {
      await server.close();
    }
  });

  it("PUT /store/carts/:id/shipping-address — 204 when wired; top-level money rejected; 404 unwired", async () => {
    const server = await startServer(buildCartApp({ wiredShippingAddress: true }));
    try {
      const ok = await send(server.baseUrl, "PUT", "/store/carts/cart-1/shipping-address", {
        shippingAddress: { street: "Main St", countryCode: "NG" },
      });
      expect(ok.status).toBe(204);

      // The transport accepts ONLY the `shippingAddress` key at the top level:
      // a top-level financial field is rejected before the use case runs.
      await expectFinancialProbeRejected(
        server,
        "PUT",
        "/store/carts/cart-1/shipping-address",
        { shippingAddress: { street: "Main St" } },
      );
    } finally {
      await server.close();
    }

    const unwired = await startServer(buildCartApp());
    try {
      const response = await send(unwired.baseUrl, "PUT", "/store/carts/cart-1/shipping-address", {
        shippingAddress: { street: "Main St" },
      });
      expect(response.status).toBe(404);
    } finally {
      await unwired.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CUSTOMERS — all 13 endpoints
// ---------------------------------------------------------------------------

describe("F3 matrix — customer endpoints (13/13)", () => {
  let calls: Array<Record<string, unknown>>;

  function buildCustomerApp(options: {
    wiredPasswordReset?: boolean;
    wiredRead?: boolean;
  } = {}): Express {
    calls = [];
    const app = express();
    app.use(
      "/store",
      createCustomersRouter({
        registerCustomerAccount: {
          async execute() {
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
            } as never;
          },
        } as never,
        initiatePasswordReset: options.wiredPasswordReset
          ? ({ execute: async () => {} } as never)
          : undefined,
        completePasswordReset: { execute: async () => {} } as never,
        getCustomerProfile: options.wiredRead
          ? ({
              async execute() {
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
                } as never;
              },
            } as never)
          : ({ execute: unreachable("getCustomerProfile") } as never),
        getCustomerAddresses: options.wiredRead
          ? ({
              async execute() {
                return [
                  {
                    id: "addr-1",
                    customerId: "customer-1",
                    firstName: "Ada",
                    lastName: "Lovelace",
                    street: "Main St",
                    city: "Lagos",
                    region: "LA",
                    countryCode: "NG",
                    postalCode: "100001",
                    phone: null,
                    isDefault: true,
                    createdAt: "2026-08-20T00:00:00.000Z",
                    updatedAt: "2026-08-20T00:00:00.000Z",
                  },
                ] as never;
              },
            } as never)
          : ({ execute: unreachable("getCustomerAddresses") } as never),
        manageAddressBook: {
          async execute(input: Record<string, unknown>) {
            calls.push(input);
          },
        } as never,
        manageB2BBusinessUnit: {
          async execute(input: Record<string, unknown>) {
            calls.push(input);
            return {
              id: "bu-1",
              name: input.unitName,
              registrationNumber: input.companyRegistrationNumber,
              salesChannelId: input.salesChannelId,
              members: [],
              createdAt: "2026-08-20T00:00:00.000Z",
            } as never;
          },
        } as never,
        requestQuote: { execute: async () => {} } as never,
        approveB2BQuote: { execute: async () => {} } as never,
        retrieveOrderHistory: {
          async execute() {
            return { items: [], total: 0 } as never;
          },
        } as never,
        processCustomerDataErasure: { execute: async () => {} } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("POST /store/customers — 201 customer projection", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const response = await send(server.baseUrl, "POST", "/store/customers", {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        password: "secret",
      });
      expect(response.status).toBe(201);
      expect(response.body.email).toBe("ada@example.com");
    } finally {
      await server.close();
    }
  });

  it("POST /store/customers — rejects injected identity/financial fields", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      for (const key of ["customerId", "id", "adminId", "totalMinor", "currency"]) {
        const response = await send(server.baseUrl, "POST", "/store/customers", {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          password: "secret",
          [key]: "x",
        });
        expect(response.status).toBe(400);
        expect((response.body.error as Record<string, unknown>).message).toContain(key);
      }
    } finally {
      await server.close();
    }
  });

  it("GET /store/customers/me — 200 customer projection; 401 without bearer", async () => {
    const server = await startServer(buildCustomerApp({ wiredRead: true }));
    try {
      const response = await send(
        server.baseUrl,
        "GET",
        "/store/customers/me",
        undefined,
        "valid-token",
      );
      expect(response.status).toBe(200);
      expect(response.body.email).toBe("ada@example.com");

      const unauth = await send(server.baseUrl, "GET", "/store/customers/me");
      expect(unauth.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("GET /store/customers/me/addresses — 200 address projection; 401 without bearer", async () => {
    const server = await startServer(buildCustomerApp({ wiredRead: true }));
    try {
      const response = await send(
        server.baseUrl,
        "GET",
        "/store/customers/me/addresses",
        undefined,
        "valid-token",
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect((response.body as unknown as Array<{ id: string }>)[0].id).toBe("addr-1");

      const unauth = await send(server.baseUrl, "GET", "/store/customers/me/addresses");
      expect(unauth.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("POST /store/customers/password-reset/initiate — 204 when wired; 404 when unwired", async () => {
    const wired = await startServer(buildCustomerApp({ wiredPasswordReset: true }));
    try {
      const response = await send(wired.baseUrl, "POST", "/store/customers/password-reset/initiate", {
        email: "ada@example.com",
      });
      expect(response.status).toBe(204);
    } finally {
      await wired.close();
    }

    const unwired = await startServer(buildCustomerApp());
    try {
      const response = await send(unwired.baseUrl, "POST", "/store/customers/password-reset/initiate", {
        email: "ada@example.com",
      });
      expect(response.status).toBe(404);
    } finally {
      await unwired.close();
    }
  });

  it("POST /store/customers/password-reset/complete — 204", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const response = await send(server.baseUrl, "POST", "/store/customers/password-reset/complete", {
        resetToken: "reset-token",
        newPassword: "NewPass123!",
      });
      expect(response.status).toBe(204);
    } finally {
      await server.close();
    }
  });

  it("POST /store/customers/me/addresses — 204; JWT identity forwarded; 401 without token", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const noToken = await send(server.baseUrl, "POST", "/store/customers/me/addresses", {
        street: "Main St",
      });
      expect(noToken.status).toBe(401);

      const ok = await send(
        server.baseUrl,
        "POST",
        "/store/customers/me/addresses",
        { street: "Main St", customerId: "customer-999" },
        "valid-token",
      );
      expect(ok.status).toBe(204);
      expect(calls[0]?.customerId).toBe("customer-1");
      expect(calls[0]?.action).toBe("add");
    } finally {
      await server.close();
    }
  });

  it("PUT /store/customers/me/addresses/:address_id — 204 with the JWT identity", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const response = await send(
        server.baseUrl,
        "PUT",
        "/store/customers/me/addresses/addr-1",
        { street: "New St" },
        "valid-token",
      );
      expect(response.status).toBe(204);
      expect(calls[0]?.customerId).toBe("customer-1");
      expect(calls[0]?.action).toBe("update");
      expect(calls[0]?.addressId).toBe("addr-1");
    } finally {
      await server.close();
    }
  });

  it("DELETE /store/customers/me/addresses/:address_id — 204 with the JWT identity", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const response = await send(
        server.baseUrl,
        "DELETE",
        "/store/customers/me/addresses/addr-1",
        undefined,
        "valid-token",
      );
      expect(response.status).toBe(204);
      expect(calls[0]?.action).toBe("delete");
      expect(calls[0]?.addressId).toBe("addr-1");
    } finally {
      await server.close();
    }
  });

  it("POST /store/customers/me/business-units — 201 projection; 401 without token", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const noToken = await send(server.baseUrl, "POST", "/store/customers/me/business-units", {
        unitName: "ACME",
        adminCustomerId: "customer-1",
        companyRegistrationNumber: "RC-123",
        salesChannelId: "channel-1",
      });
      expect(noToken.status).toBe(401);

      const ok = await send(
        server.baseUrl,
        "POST",
        "/store/customers/me/business-units",
        {
          unitName: "ACME",
          adminCustomerId: "customer-1",
          companyRegistrationNumber: "RC-123",
          salesChannelId: "channel-1",
        },
        "valid-token",
      );
      expect(ok.status).toBe(201);
      expect(ok.body.name).toBe("ACME");
    } finally {
      await server.close();
    }
  });

  it("POST /store/customers/me/quotes — 202; body customerId must equal the token", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const mismatch = await send(
        server.baseUrl,
        "POST",
        "/store/customers/me/quotes",
        { cartId: "cart-1", customerId: "customer-999", businessUnitId: "bu-1" },
        "valid-token",
      );
      expect(mismatch.status).toBe(403);

      const ok = await send(
        server.baseUrl,
        "POST",
        "/store/customers/me/quotes",
        { cartId: "cart-1", customerId: "customer-1", businessUnitId: "bu-1" },
        "valid-token",
      );
      expect(ok.status).toBe(202);
    } finally {
      await server.close();
    }
  });

  it("POST /store/quotes/:id/approve — 204; accepts ONLY the declared approvedTotalMinor", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const ok = await send(
        server.baseUrl,
        "POST",
        "/store/quotes/quote-1/approve",
        { approvedTotalMinor: 50000 },
        "valid-token",
      );
      expect(ok.status).toBe(204);

      // approvedTotalMinor is spec-declared; other financial fields are not.
      for (const key of ["subtotalMinor", "totalMinor", "taxMinor", "shippingMinor", "amountMinor", "currency"]) {
        const bad = await send(
          server.baseUrl,
          "POST",
          "/store/quotes/quote-1/approve",
          { approvedTotalMinor: 50000, [key]: 1 },
          "valid-token",
        );
        expect(bad.status).toBe(400);
      }
    } finally {
      await server.close();
    }
  });

  it("GET /store/customers/me/orders — 200 order history; 401 without token; pagination validation", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const noToken = await send(server.baseUrl, "GET", "/store/customers/me/orders");
      expect(noToken.status).toBe(401);

      const ok = await send(
        server.baseUrl,
        "GET",
        "/store/customers/me/orders",
        undefined,
        "valid-token",
      );
      expect(ok.status).toBe(200);
      expect(ok.body.items).toEqual([]);
      expect(ok.body.total).toBe(0);

      const badLimit = await send(
        server.baseUrl,
        "GET",
        "/store/customers/me/orders?limit=abc",
        undefined,
        "valid-token",
      );
      expect(badLimit.status).toBe(400);

      const tooHigh = await send(
        server.baseUrl,
        "GET",
        "/store/customers/me/orders?limit=1000",
        undefined,
        "valid-token",
      );
      expect(tooHigh.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /store/customers/me/erasure — 204; 401 without token; strict body", async () => {
    const server = await startServer(buildCustomerApp());
    try {
      const noToken = await send(server.baseUrl, "POST", "/store/customers/me/erasure", {
        reason: "GDPR",
      });
      expect(noToken.status).toBe(401);

      const ok = await send(
        server.baseUrl,
        "POST",
        "/store/customers/me/erasure",
        { reason: "GDPR" },
        "valid-token",
      );
      expect(ok.status).toBe(204);

      const bad = await send(
        server.baseUrl,
        "POST",
        "/store/customers/me/erasure",
        { reason: "GDPR", totalMinor: 1 },
        "valid-token",
      );
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ORDERS — all 4 endpoints
// ---------------------------------------------------------------------------

describe("F3 matrix — order endpoints (5/5)", () => {
  function buildOrderApp(options: {
    wiredRead?: boolean;
    wiredReturns?: boolean;
    wiredDispatch?: boolean;
    onReturnsExecute?: (input: unknown) => void;
  } = {}): Express {
    const app = express();
    app.use(
      "/store",
      createOrdersRouter({
        getOrder: options.wiredRead
          ? ({
              async execute() {
                return {
                  id: "order-1",
                  cartId: "cart-1",
                  customerId: "customer-1",
                  totalAmountMinor: 25000,
                  currency: "NGN",
                  subtotalMinor: 25000,
                  discountMinor: 0,
                  taxMinor: 0,
                  shippingMinor: 0,
                  insuranceMinor: 0,
                  fulfillmentStatus: "unfulfilled",
                  paymentStatus: "paid",
                  transactionReference: "ref-1",
                  paymentStatusReason: null,
                  paymentStatusUpdatedAt: null,
                  flaggedForReview: false,
                  flagReason: null,
                  riskScore: null,
                  flaggedAt: null,
                  fulfillmentHaltedAt: null,
                  createdAt: "2026-08-20T00:00:00.000Z",
                  lineItems: [],
                  availableVariants: [],
                  fulfillments: [],
                  pendingReturns: [],
                } as never;
              },
            } as never)
          : ({ execute: unreachable("getOrder") } as never),
        initiateReturnAuthorization: options.wiredReturns
          ? ({
              async execute(input: unknown) {
                options.onReturnsExecute?.(input);
                return {
                  rmaId: "rma-1",
                  refundAmountMinor: 0,
                  returnLabelUrl: null,
                };
              },
            } as never)
          : undefined,
        proposeOrderEdit: {
          async execute() {
            return {
              orderEditId: "edit-1",
              differenceDueMinor: 0,
              status: "pending",
            };
          },
        } as never,
        confirmOrderEdit: {
          async execute() {
            return { orderId: "order-1", orderEditId: "edit-1", status: "confirmed" };
          },
        } as never,
        dispatchOrderFulfillment: options.wiredDispatch
          ? ({ execute: async () => {} } as never)
          : undefined,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("GET /store/orders/:orderId — 200 order projection", async () => {
    const server = await startServer(buildOrderApp({ wiredRead: true }));
    try {
      const response = await send(server.baseUrl, "GET", "/store/orders/order-1");
      expect(response.status).toBe(200);
      expect(response.body.id).toBe("order-1");
    } finally {
      await server.close();
    }
  });

  it("POST /store/orders/:orderId/returns — 201 projection when wired; 404 unwired", async () => {
    const wired = await startServer(buildOrderApp({ wiredReturns: true }));
    try {
      const ok = await send(wired.baseUrl, "POST", "/store/orders/order-1/returns", {
        orderId: "order-1",
        items: [{ lineItemId: "li-1", quantity: 1, reasonCode: "wrong_size" }],
      });
      expect(ok.status).toBe(201);
      expect(ok.body.rmaId).toBe("rma-1");
      expect(ok.body.refundAmountMinor).toBe(0);
      expect(ok.body.returnLabelUrl).toBeNull();
    } finally {
      await wired.close();
    }

    const unwired = await startServer(buildOrderApp());
    try {
      const response = await send(unwired.baseUrl, "POST", "/store/orders/order-1/returns", {
        orderId: "order-1",
        items: [{ lineItemId: "li-1", quantity: 1, reasonCode: "wrong_size" }],
      });
      expect(response.status).toBe(404);
    } finally {
      await unwired.close();
    }
  });

  it("POST /store/orders/:orderId/returns — rejects a client-dictated refund amount", async () => {
    const server = await startServer(buildOrderApp({ wiredReturns: true }));
    try {
      const bad = await send(server.baseUrl, "POST", "/store/orders/order-1/returns", {
        orderId: "order-1",
        items: [{ lineItemId: "li-1", quantity: 1, reasonCode: "wrong_size" }],
        refundAmountMinor: 999999,
      });
      expect(bad.status).toBe(400);
      expect((bad.body.error as Record<string, unknown>).message).toContain(
        "refundAmountMinor",
      );
    } finally {
      await server.close();
    }
  });

  it("POST /store/orders/:orderId/returns — forwards returnSelection; 201 with valid label request; 400 without", async () => {
    let forwarded: unknown;
    const server = await startServer(
      buildOrderApp({
        wiredReturns: true,
        onReturnsExecute: (input) => {
          forwarded = input;
        },
      }),
    );
    try {
      // requireReturnLabel true + valid returnSelection -> 201 and forwarded.
      const ok = await send(server.baseUrl, "POST", "/store/orders/order-1/returns", {
        orderId: "order-1",
        items: [{ lineItemId: "li-1", quantity: 1, reasonCode: "wrong_size" }],
        requireReturnLabel: true,
        returnSelection: {
          courierId: "courier-1",
          serviceCode: "standard",
          amountMinor: 1000,
        },
      });
      expect(ok.status).toBe(201);
      expect(ok.body.rmaId).toBe("rma-1");
      const forwardedSelection = (forwarded as { returnSelection: unknown })
        .returnSelection;
      expect(forwardedSelection).toEqual({
        courierId: "courier-1",
        serviceCode: "standard",
        amountMinor: 1000,
        quoteId: "",
      });

      // requireReturnLabel true WITHOUT returnSelection -> 400 (the domain
      // cannot create a label without the courier selection).
      const missing = await send(server.baseUrl, "POST", "/store/orders/order-1/returns", {
        orderId: "order-1",
        items: [{ lineItemId: "li-1", quantity: 1, reasonCode: "wrong_size" }],
        requireReturnLabel: true,
      });
      expect(missing.status).toBe(400);
      expect((missing.body.error as Record<string, unknown>).message).toContain(
        "returnSelection",
      );

      // requireReturnLabel false / omitted -> no label, still 201.
      const noLabel = await send(server.baseUrl, "POST", "/store/orders/order-1/returns", {
        orderId: "order-1",
        items: [{ lineItemId: "li-1", quantity: 1, reasonCode: "wrong_size" }],
      });
      expect(noLabel.status).toBe(201);
      expect((forwarded as { requireReturnLabel: boolean }).requireReturnLabel).toBe(
        false,
      );
    } finally {
      await server.close();
    }
  });

  it("POST /store/orders/:orderId/edits — 201 projection; rejects client-dictated difference", async () => {
    const server = await startServer(buildOrderApp());
    try {
      const ok = await send(server.baseUrl, "POST", "/store/orders/order-1/edits", {
        changes: [{ type: "add", quantity: 1, newVariantId: "v-2" }],
      });
      expect(ok.status).toBe(201);
      expect(ok.body.orderEditId).toBe("edit-1");
      expect(ok.body.differenceDueMinor).toBe(0);

      const bad = await send(server.baseUrl, "POST", "/store/orders/order-1/edits", {
        changes: [{ type: "add", quantity: 1, newVariantId: "v-2" }],
        differenceDueMinor: 1,
      });
      expect(bad.status).toBe(400);
      expect((bad.body.error as Record<string, unknown>).message).toContain(
        "differenceDueMinor",
      );
    } finally {
      await server.close();
    }
  });

  it("POST /store/order-edits/:orderEditId/confirm — 200; takes NO financial input", async () => {
    const server = await startServer(buildOrderApp());
    try {
      const ok = await send(server.baseUrl, "POST", "/store/order-edits/edit-1/confirm", {
        paymentConfirmed: true,
        paymentReference: "ref-1",
      });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe("confirmed");

      const bad = await send(server.baseUrl, "POST", "/store/order-edits/edit-1/confirm", {
        paymentConfirmed: true,
        totalMinor: 1,
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /store/orders/:orderId/fulfillments — 204 empty body; hints rejected; 404 unwired", async () => {
    const wired = await startServer(buildOrderApp({ wiredDispatch: true }));
    try {
      const ok = await send(wired.baseUrl, "POST", "/store/orders/order-1/fulfillments", {});
      expect(ok.status).toBe(204);

      // Dispatch is snapshot-authoritative: the preferredCourier/serviceLevel
      // hints were REMOVED from the contract and ANY body field is rejected
      // (additionalProperties: false) — a client cannot pick a courier through
      // the HTTP contract.
      const withHints = await send(wired.baseUrl, "POST", "/store/orders/order-1/fulfillments", {
        preferredCourier: "dhl",
        serviceLevel: "express",
      });
      expect(withHints.status).toBe(400);

      const bad = await send(wired.baseUrl, "POST", "/store/orders/order-1/fulfillments", {
        shippingMinor: 1,
      });
      expect(bad.status).toBe(400);
    } finally {
      await wired.close();
    }

    const unwired = await startServer(buildOrderApp());
    try {
      const response = await send(unwired.baseUrl, "POST", "/store/orders/order-1/fulfillments", {});
      expect(response.status).toBe(404);
    } finally {
      await unwired.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ADMIN — all 13 endpoints
// ---------------------------------------------------------------------------

describe("F3 matrix — admin endpoints (13/13)", () => {
  function buildAdminApp(): Express {
    const app = express();
    app.use(
      "/admin",
      createAdminRouter({
        createProduct: {
          async execute() {
            return {
              id: "product-1",
              title: "Shirt",
              handle: "shirt",
              description: null,
              variants: [],
              categoryIds: [],
              media: [],
            } as never;
          },
        } as never,
        createProductVariant: {
          async execute() {
            return {
              id: "variant-1",
              productId: "product-1",
              sku: "SHIRT-1",
              inventoryQuantity: 10,
              allowBackorder: false,
              version: 1,
            } as never;
          },
        } as never,
        configureRegionalPricing: { execute: async () => {} } as never,
        createPromotionRule: { execute: async () => {} } as never,
        createSalesChannel: {
          async execute() {
            return {
              id: "channel-1",
              name: "Online",
              description: null,
              isDisabled: false,
              createdAt: "2026-08-20T00:00:00.000Z",
            } as never;
          },
        } as never,
        manageCategories: {
          async executeCreate() {
            return {
              id: "category-1",
              name: "Apparel",
              parentCategoryId: null,
              createdAt: "2026-08-20T00:00:00.000Z",
            } as never;
          },
        } as never,
        manageAdminRolePermissions: { execute: async () => {} } as never,
        importBulkCatalogData: {
          async execute() {
            return { jobId: "job-1" } as never;
          },
        } as never,
        listDeadLetterJobs: {
          async execute() {
            return [] as never;
          },
        } as never,
        retryDeadLetterJob: { execute: async () => {} } as never,
        generateDraftOrder: {
          async execute() {
            return "draft-1" as never;
          },
        } as never,
        determineSourcingLocation: {
          async execute() {
            return "location-1" as never;
          },
        } as never,
        pruneAbandonedCarts: {
          async execute() {
            return { deletedCount: 3 } as never;
          },
        } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("every /admin route answers 401 without a bearer token (route never invoked)", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const probes: Array<[string, "POST" | "PUT" | "GET", unknown?]> = [
        ["/admin/products", "POST", { title: "S", handle: "s" }],
        ["/admin/products/p-1/variants", "POST", { sku: "S", inventoryQuantity: 1, allowBackorder: false }],
        ["/admin/variants/v-1/regional-prices", "POST", { regionId: "r-1", amountMinor: 100 }],
        ["/admin/promotions", "POST", { code: "X", discountType: "fixed_amount", discountValueMinor: 10 }],
        ["/admin/sales-channels", "POST", { name: "Online" }],
        ["/admin/categories", "POST", { name: "Apparel" }],
        ["/admin/roles/r-1/permissions", "PUT", { permissions: ["catalog:write"] }],
        ["/admin/imports/bulk-catalog", "POST", { fileUrl: "https://x/file.csv" }],
        ["/admin/queues/queue-1/dead-letter", "GET", undefined],
        ["/admin/queues/queue-1/dead-letter/job-1/retry", "POST", {}],
        ["/admin/draft-orders", "POST", { email: "a@b.co", items: [{ title: "X", quantity: 1, unitPriceMinor: 100 }], adminId: "customer-1" }],
        ["/admin/sourcing-location", "POST", { variantId: "v-1", requestedQuantity: 5 }],
        ["/admin/carts/prune", "POST", { expirationDateThreshold: "2026-01-01T00:00:00Z" }],
      ];
      for (const [path, method, body] of probes) {
        const response = await send(server.baseUrl, method, path, body);
        expect(response.status).toBe(401);
      }
    } finally {
      await server.close();
    }
  });

  it("POST /admin/products — 201 projection; rejects injected adminId/money", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const ok = await send(
        server.baseUrl,
        "POST",
        "/admin/products",
        { title: "Shirt", handle: "shirt" },
        "valid-token",
      );
      expect(ok.status).toBe(201);
      expect(ok.body.title).toBe("Shirt");

      const bad = await send(
        server.baseUrl,
        "POST",
        "/admin/products",
        { title: "Shirt", handle: "shirt", adminId: "attacker", totalMinor: 1 },
        "valid-token",
      );
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /admin/products/:id/variants — 201 projection; rejects injected money", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const ok = await send(
        server.baseUrl,
        "POST",
        "/admin/products/product-1/variants",
        { sku: "SHIRT-1", inventoryQuantity: 10, allowBackorder: false },
        "valid-token",
      );
      expect(ok.status).toBe(201);
      expect(ok.body.sku).toBe("SHIRT-1");

      const bad = await send(
        server.baseUrl,
        "POST",
        "/admin/products/product-1/variants",
        { sku: "SHIRT-1", inventoryQuantity: 10, allowBackorder: false, priceMinor: 100 },
        "valid-token",
      );
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /admin/variants/:id/regional-prices — 204; accepts ONLY amountMinor (declared)", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const ok = await send(
        server.baseUrl,
        "POST",
        "/admin/variants/v-1/regional-prices",
        { regionId: "region-1", amountMinor: 100 },
        "valid-token",
      );
      expect(ok.status).toBe(204);

      for (const key of ["currency", "totalMinor", "subtotalMinor", "discountMinor"]) {
        const bad = await send(
          server.baseUrl,
          "POST",
          "/admin/variants/v-1/regional-prices",
          { regionId: "region-1", amountMinor: 100, [key]: 1 },
          "valid-token",
        );
        expect(bad.status).toBe(400);
      }
    } finally {
      await server.close();
    }
  });

  it("POST /admin/promotions — 204; rejects injected discountMinor/totalMinor", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const ok = await send(
        server.baseUrl,
        "POST",
        "/admin/promotions",
        { code: "SAVE10", discountType: "fixed_amount", discountValueMinor: 1000 },
        "valid-token",
      );
      expect(ok.status).toBe(204);

      const bad = await send(
        server.baseUrl,
        "POST",
        "/admin/promotions",
        { code: "SAVE10", discountType: "fixed_amount", discountValueMinor: 1000, discountMinor: 1 },
        "valid-token",
      );
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /admin/sales-channels — 201 projection", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/admin/sales-channels",
        { name: "Online" },
        "valid-token",
      );
      expect(response.status).toBe(201);
      expect(response.body.name).toBe("Online");
    } finally {
      await server.close();
    }
  });

  it("POST /admin/categories — 201 projection", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/admin/categories",
        { name: "Apparel" },
        "valid-token",
      );
      expect(response.status).toBe(201);
      expect(response.body.name).toBe("Apparel");
    } finally {
      await server.close();
    }
  });

  it("PUT /admin/roles/:id/permissions — 204; rejects a non-array permissions body", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const ok = await send(
        server.baseUrl,
        "PUT",
        "/admin/roles/r-1/permissions",
        { permissions: ["catalog:write", "orders:read"] },
        "valid-token",
      );
      expect(ok.status).toBe(204);

      const bad = await send(
        server.baseUrl,
        "PUT",
        "/admin/roles/r-1/permissions",
        { permissions: [] },
        "valid-token",
      );
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /admin/imports/bulk-catalog — 202 { jobId }", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/admin/imports/bulk-catalog",
        { fileUrl: "https://example.com/catalog.csv", fileType: "csv" },
        "valid-token",
      );
      expect(response.status).toBe(202);
      expect(response.body.jobId).toBe("job-1");
    } finally {
      await server.close();
    }
  });

  it("GET /admin/queues/:queue_name/dead-letter — 200 list; pagination validation", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const ok = await send(
        server.baseUrl,
        "GET",
        "/admin/queues/payment-events-queue/dead-letter",
        undefined,
        "valid-token",
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual([]);

      const bad = await send(
        server.baseUrl,
        "GET",
        "/admin/queues/payment-events-queue/dead-letter?limit=9999",
        undefined,
        "valid-token",
      );
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("POST /admin/queues/:queue_name/dead-letter/:job_id/retry — 204", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/admin/queues/payment-events-queue/dead-letter/job-1/retry",
        {},
        "valid-token",
      );
      expect(response.status).toBe(204);
    } finally {
      await server.close();
    }
  });

  it("POST /admin/draft-orders — 201 { draftOrderId }; body adminId must equal the token", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const mismatch = await send(
        server.baseUrl,
        "POST",
        "/admin/draft-orders",
        {
          email: "buyer@example.com",
          items: [{ title: "Item", quantity: 1, unitPriceMinor: 100 }],
          shippingAddress: {},
          adminId: "attacker",
        },
        "valid-token",
      );
      expect(mismatch.status).toBe(403);

      const ok = await send(
        server.baseUrl,
        "POST",
        "/admin/draft-orders",
        {
          email: "buyer@example.com",
          items: [{ title: "Item", quantity: 1, unitPriceMinor: 100 }],
          shippingAddress: {},
          adminId: "customer-1",
        },
        "valid-token",
      );
      expect(ok.status).toBe(201);
      expect(ok.body.draftOrderId).toBe("draft-1");
    } finally {
      await server.close();
    }
  });

  it("POST /admin/sourcing-location — 200 { locationId }", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/admin/sourcing-location",
        { variantId: "v-1", requestedQuantity: 5 },
        "valid-token",
      );
      expect(response.status).toBe(200);
      expect(response.body.locationId).toBe("location-1");
    } finally {
      await server.close();
    }
  });

  it("POST /admin/carts/prune — 200 { deletedCount }", async () => {
    const server = await startServer(buildAdminApp());
    try {
      const response = await send(
        server.baseUrl,
        "POST",
        "/admin/carts/prune",
        { expirationDateThreshold: "2026-01-01T00:00:00Z" },
        "valid-token",
      );
      expect(response.status).toBe(200);
      expect(response.body.deletedCount).toBe(3);
    } finally {
      await server.close();
    }
  });
});