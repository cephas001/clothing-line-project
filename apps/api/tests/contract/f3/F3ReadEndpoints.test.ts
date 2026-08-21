// apps/api/tests/contract/f3/F3ReadEndpoints.test.ts
//
// FOCUSED TESTS — the four F3.5 READ endpoints added in this phase:
//   GET /store/carts/:id          -> GetCartUseCase
//   GET /store/customers/me       -> GetCustomerProfileUseCase
//   GET /store/customers/me/addresses -> GetCustomerAddressesUseCase
//   GET /store/orders/:orderId    -> GetOrderUseCase
//
// Each endpoint is verified at the transport boundary for the four scenarios
// that matter:
//   - happy path       -> 200 with the public projection
//   - not found        -> 404 (CART_NOT_FOUND / RESOURCE_NOT_FOUND)
//   - unauthorized     -> 401 (missing OR forged bearer JWT)
//   - ownership        -> 403 PERMISSION_DENIED (customer-bound cart / order
//                         read by a DIFFERENT authenticated customer)
//
// The cart and order reads are PUBLIC operations (security: []): a guest
// (no bearer) may read, and a presented identity that differs from the
// resource owner is a denied read — never an existence leak. The /me reads
// REQUIRE a bearer and derive the identity from the JWT ONLY. The same four
// use cases are then exercised at the DOMAIN level (in-memory fakes) to prove
// the ownership/not-found rules are enforced by the use case, not just the
// stub.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import express, { Express } from "express";
import type { AddressInfo } from "node:net";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Cart } from "@api/domain/entities/Cart";
import { Customer } from "@api/domain/entities/Customer";
import { Order } from "@api/domain/entities/Order";
import { FakeTokenService } from "../../fakes/FakeTokenService";
import { NoopLogger } from "../../fakes/NoopLogger";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryCustomerRepository } from "../../fakes/InMemoryCustomerRepository";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { createCartRouter } from "@api/adapters/http/routers/CartRouter";
import { createCustomersRouter } from "@api/adapters/http/routers/CustomersRouter";
import { createOrdersRouter } from "@api/adapters/http/routers/OrdersRouter";
import { GetCartUseCase } from "@api/use-cases/cart/GetCartUseCase";
import { GetCustomerProfileUseCase } from "@api/use-cases/customers/GetCustomerProfileUseCase";
import { GetCustomerAddressesUseCase } from "@api/use-cases/customers/GetCustomerAddressesUseCase";
import { GetOrderUseCase } from "@api/use-cases/logistics/GetOrderUseCase";

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
  method: "GET",
  path: string,
  bearer?: string,
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers });
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

function tokenService(): FakeTokenService {
  return new FakeTokenService(
    new Map([["valid-token", { customerId: "customer-1", email: "buyer@example.com", roles: [] }]]),
  );
}

function cartStub(): unknown {
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
}

function orderStub(): unknown {
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
}

function customerStub(): unknown {
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
}

// ---------------------------------------------------------------------------
// HTTP TRANSPORT BOUNDARY
// ---------------------------------------------------------------------------

describe("GET /store/carts/:id — read endpoint contract", () => {
  function buildApp(execute: (input: { cartId: string; actorId?: string }) => Promise<unknown> | unknown): Express {
    const app = express();
    app.use(
      "/store/carts",
      createCartRouter({
        initializeCartSession: { execute: async () => cartStub() } as never,
        getCart: { execute } as never,
        addCustomLineItem: { execute: async () => {} } as never,
        updateLineItemQuantity: { execute: async () => {} } as never,
        removeCartLineItem: { execute: async () => {} } as never,
        applyDiscountCode: { execute: async () => {} } as never,
        mergeGuestCartToCustomer: { execute: async () => {} } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("happy path — 200 public cart projection (guest read allowed)", async () => {
    const server = await startServer(buildApp(async () => cartStub()));
    try {
      const response = await send(server.baseUrl, "GET", "/store/carts/cart-1");
      expect(response.status).toBe(200);
      expect(response.body.id).toBe("cart-1");
      expect((response.body as Record<string, unknown>).customerId).toBe("customer-1");
    } finally {
      await server.close();
    }
  });

  it("happy path — 200 with an owning bearer identity (identity forwarded)", async () => {
    let received: { cartId: string; actorId?: string } | undefined;
    const server = await startServer(
      buildApp(async (input) => {
        received = input;
        return cartStub();
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/carts/cart-1", "valid-token");
      expect(response.status).toBe(200);
      expect(received?.cartId).toBe("cart-1");
      expect(received?.actorId).toBe("customer-1");
    } finally {
      await server.close();
    }
  });

  it("not found — 404 CART_NOT_FOUND when the cart does not exist", async () => {
    const server = await startServer(
      buildApp(async () => {
        throw new DomainError("CART_NOT_FOUND", "Cart session not found.");
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/carts/missing-1");
      expect(response.status).toBe(404);
      expect((response.body.error as Record<string, unknown>).code).toBe("CART_NOT_FOUND");
    } finally {
      await server.close();
    }
  });

  it("unauthorized — 401 UNAUTHORIZED_ACCESS for a forged bearer token", async () => {
    const server = await startServer(buildApp(async () => cartStub()));
    try {
      const response = await send(server.baseUrl, "GET", "/store/carts/cart-1", "forged-token");
      expect(response.status).toBe(401);
      expect((response.body.error as Record<string, unknown>).code).toBe("UNAUTHORIZED_ACCESS");
    } finally {
      await server.close();
    }
  });

  it("ownership violation — 403 PERMISSION_DENIED for another customer's cart", async () => {
    const server = await startServer(
      buildApp(async () => {
        throw new DomainError(
          "PERMISSION_DENIED",
          "The authenticated customer does not own this cart.",
        );
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/carts/cart-1", "valid-token");
      expect(response.status).toBe(403);
      expect((response.body.error as Record<string, unknown>).code).toBe("PERMISSION_DENIED");
    } finally {
      await server.close();
    }
  });
});

describe("GET /store/orders/:orderId — read endpoint contract", () => {
  function buildApp(execute: (input: { orderId: string; actorId?: string }) => Promise<unknown> | unknown): Express {
    const app = express();
    app.use(
      "/store",
      createOrdersRouter({
        getOrder: { execute } as never,
        proposeOrderEdit: { execute: async () => ({}) } as never,
        confirmOrderEdit: { execute: async () => ({}) } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("happy path — 200 public order projection (guest read allowed)", async () => {
    const server = await startServer(buildApp(async () => orderStub()));
    try {
      const response = await send(server.baseUrl, "GET", "/store/orders/order-1");
      expect(response.status).toBe(200);
      expect(response.body.id).toBe("order-1");
      expect((response.body as Record<string, unknown>).totalAmountMinor).toBe(25000);
    } finally {
      await server.close();
    }
  });

  it("happy path — 200 with an owning bearer identity (identity forwarded)", async () => {
    let received: { orderId: string; actorId?: string } | undefined;
    const server = await startServer(
      buildApp(async (input) => {
        received = input;
        return orderStub();
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/orders/order-1", "valid-token");
      expect(response.status).toBe(200);
      expect(received?.orderId).toBe("order-1");
      expect(received?.actorId).toBe("customer-1");
    } finally {
      await server.close();
    }
  });

  it("not found — 404 RESOURCE_NOT_FOUND when the order does not exist", async () => {
    const server = await startServer(
      buildApp(async () => {
        throw new DomainError("RESOURCE_NOT_FOUND", "Order not found.");
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/orders/missing-1");
      expect(response.status).toBe(404);
      expect((response.body.error as Record<string, unknown>).code).toBe("RESOURCE_NOT_FOUND");
    } finally {
      await server.close();
    }
  });

  it("unauthorized — 401 UNAUTHORIZED_ACCESS for a forged bearer token", async () => {
    const server = await startServer(buildApp(async () => orderStub()));
    try {
      const response = await send(server.baseUrl, "GET", "/store/orders/order-1", "forged-token");
      expect(response.status).toBe(401);
      expect((response.body.error as Record<string, unknown>).code).toBe("UNAUTHORIZED_ACCESS");
    } finally {
      await server.close();
    }
  });

  it("ownership violation — 403 PERMISSION_DENIED for another customer's order", async () => {
    const server = await startServer(
      buildApp(async () => {
        throw new DomainError(
          "PERMISSION_DENIED",
          "The authenticated customer does not own this order.",
        );
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/orders/order-1", "valid-token");
      expect(response.status).toBe(403);
      expect((response.body.error as Record<string, unknown>).code).toBe("PERMISSION_DENIED");
    } finally {
      await server.close();
    }
  });
});

describe("GET /store/customers/me — read endpoint contract", () => {
  function buildApp(execute: (input: { customerId: string; actorId?: string }) => Promise<unknown> | unknown): Express {
    const app = express();
    app.use(
      "/store",
      createCustomersRouter({
        registerCustomerAccount: { execute: async () => customerStub() } as never,
        getCustomerProfile: { execute } as never,
        getCustomerAddresses: { execute: async () => [] } as never,
        completePasswordReset: { execute: async () => {} } as never,
        manageAddressBook: { execute: async () => {} } as never,
        manageB2BBusinessUnit: { execute: async () => ({}) } as never,
        requestQuote: { execute: async () => {} } as never,
        approveB2BQuote: { execute: async () => {} } as never,
        retrieveOrderHistory: { execute: async () => ({ items: [], total: 0 }) } as never,
        processCustomerDataErasure: { execute: async () => {} } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("happy path — 200 customer projection with the JWT identity", async () => {
    let received: { customerId: string; actorId?: string } | undefined;
    const server = await startServer(
      buildApp(async (input) => {
        received = input;
        return customerStub();
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/customers/me", "valid-token");
      expect(response.status).toBe(200);
      expect(response.body.email).toBe("ada@example.com");
      // The identity is ALWAYS the bearer JWT identity — never client-supplied.
      expect(received?.customerId).toBe("customer-1");
      expect(received?.actorId).toBe("customer-1");
    } finally {
      await server.close();
    }
  });

  it("not found — 404 RESOURCE_NOT_FOUND when the customer does not exist", async () => {
    const server = await startServer(
      buildApp(async () => {
        throw new DomainError("RESOURCE_NOT_FOUND", "Customer not found.");
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/customers/me", "valid-token");
      expect(response.status).toBe(404);
      expect((response.body.error as Record<string, unknown>).code).toBe("RESOURCE_NOT_FOUND");
    } finally {
      await server.close();
    }
  });

  it("unauthorized — 401 without a bearer token", async () => {
    const server = await startServer(buildApp(async () => customerStub()));
    try {
      const response = await send(server.baseUrl, "GET", "/store/customers/me");
      expect(response.status).toBe(401);
      expect((response.body.error as Record<string, unknown>).code).toBe("UNAUTHORIZED_ACCESS");
    } finally {
      await server.close();
    }
  });

  it("unauthorized — 401 UNAUTHORIZED_ACCESS for a forged bearer token", async () => {
    const server = await startServer(buildApp(async () => customerStub()));
    try {
      const response = await send(server.baseUrl, "GET", "/store/customers/me", "forged-token");
      expect(response.status).toBe(401);
      expect((response.body.error as Record<string, unknown>).code).toBe("UNAUTHORIZED_ACCESS");
    } finally {
      await server.close();
    }
  });
});

describe("GET /store/customers/me/addresses — read endpoint contract", () => {
  const ADDRESS_BOOK = [
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
  ];

  function buildApp(execute: (input: { customerId: string; actorId?: string }) => Promise<unknown> | unknown): Express {
    const app = express();
    app.use(
      "/store",
      createCustomersRouter({
        registerCustomerAccount: { execute: async () => customerStub() } as never,
        getCustomerProfile: { execute: async () => customerStub() } as never,
        getCustomerAddresses: { execute } as never,
        completePasswordReset: { execute: async () => {} } as never,
        manageAddressBook: { execute: async () => {} } as never,
        manageB2BBusinessUnit: { execute: async () => ({}) } as never,
        requestQuote: { execute: async () => {} } as never,
        approveB2BQuote: { execute: async () => {} } as never,
        retrieveOrderHistory: { execute: async () => ({ items: [], total: 0 }) } as never,
        processCustomerDataErasure: { execute: async () => {} } as never,
        tokenService: tokenService(),
        logger: new NoopLogger(),
      }),
    );
    return app;
  }

  it("happy path — 200 address book with the JWT identity", async () => {
    let received: { customerId: string; actorId?: string } | undefined;
    const server = await startServer(
      buildApp(async (input) => {
        received = input;
        return ADDRESS_BOOK;
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/customers/me/addresses", "valid-token");
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect((response.body as unknown as Array<{ id: string }>)[0].id).toBe("addr-1");
      expect(received?.customerId).toBe("customer-1");
      expect(received?.actorId).toBe("customer-1");
    } finally {
      await server.close();
    }
  });

  it("not found — 404 RESOURCE_NOT_FOUND when the customer does not exist", async () => {
    const server = await startServer(
      buildApp(async () => {
        throw new DomainError("RESOURCE_NOT_FOUND", "Customer not found.");
      }),
    );
    try {
      const response = await send(server.baseUrl, "GET", "/store/customers/me/addresses", "valid-token");
      expect(response.status).toBe(404);
      expect((response.body.error as Record<string, unknown>).code).toBe("RESOURCE_NOT_FOUND");
    } finally {
      await server.close();
    }
  });

  it("unauthorized — 401 without a bearer token", async () => {
    const server = await startServer(buildApp(async () => ADDRESS_BOOK));
    try {
      const response = await send(server.baseUrl, "GET", "/store/customers/me/addresses");
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("unauthorized — 401 UNAUTHORIZED_ACCESS for a forged bearer token", async () => {
    const server = await startServer(buildApp(async () => ADDRESS_BOOK));
    try {
      const response = await send(server.baseUrl, "GET", "/store/customers/me/addresses", "forged-token");
      expect(response.status).toBe(401);
      expect((response.body.error as Record<string, unknown>).code).toBe("UNAUTHORIZED_ACCESS");
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// DOMAIN USE-CASE LEVEL (ownership / not-found enforced by the use case)
// ---------------------------------------------------------------------------

describe("GetCartUseCase — read ownership semantics", () => {
  const audit = new InMemoryAuditLogService();
  const idGen = new SequenceIdGenerator();
  const logger = new NoopLogger();

  function repo(owner: string | null): InMemoryCartRepository {
    const repository = new InMemoryCartRepository();
    repository.seed(
      new Cart({
        id: "cart-1",
        regionId: "region-1",
        salesChannelId: "channel-1",
        customerId: owner,
      }),
    );
    return repository;
  }

  it("returns the cart to its owning customer", async () => {
    const useCase = new GetCartUseCase(repo("customer-1"), audit, idGen, logger);
    const cart = await useCase.execute({ cartId: "cart-1", actorId: "customer-1" });
    expect(cart.id).toBe("cart-1");
    expect(audit.actions().some((action) => action === "CART_RETRIEVED")).toBe(true);
  });

  it("allows a guest (no identity) read of a customer-bound cart", async () => {
    const useCase = new GetCartUseCase(repo("customer-1"), audit, idGen, logger);
    const cart = await useCase.execute({ cartId: "cart-1" });
    expect(cart.id).toBe("cart-1");
  });

  it("rejects a read by a DIFFERENT authenticated customer (PERMISSION_DENIED)", async () => {
    const useCase = new GetCartUseCase(repo("customer-1"), audit, idGen, logger);
    await expect(
      useCase.execute({ cartId: "cart-1", actorId: "customer-2" }),
    ).rejectsWithCode("PERMISSION_DENIED");
  });

  it("rejects a missing cart with CART_NOT_FOUND", async () => {
    const useCase = new GetCartUseCase(repo("customer-1"), audit, idGen, logger);
    await expect(useCase.execute({ cartId: "missing-1" })).rejectsWithCode("CART_NOT_FOUND");
  });
});

describe("GetOrderUseCase — read ownership semantics", () => {
  const audit = new InMemoryAuditLogService();
  const idGen = new SequenceIdGenerator();
  const logger = new NoopLogger();

  function repo(): InMemoryOrderRepository {
    const repository = new InMemoryOrderRepository();
    repository.seed(
      new Order({
        id: "order-1",
        cartId: "cart-1",
        customerId: "customer-1",
        totalAmountMinor: 25000,
      }),
    );
    return repository;
  }

  it("returns the order to its owning customer", async () => {
    const useCase = new GetOrderUseCase(repo(), audit, idGen, logger);
    const order = await useCase.execute({ orderId: "order-1", actorId: "customer-1" });
    expect(order.id).toBe("order-1");
    expect(order.totalAmountMinor).toBe(25000);
    expect(audit.actions().some((action) => action === "ORDER_RETRIEVED")).toBe(true);
  });

  it("allows a guest (no identity) read of an order snapshot", async () => {
    const useCase = new GetOrderUseCase(repo(), audit, idGen, logger);
    const order = await useCase.execute({ orderId: "order-1" });
    expect(order.id).toBe("order-1");
  });

  it("rejects a read by a DIFFERENT authenticated customer (PERMISSION_DENIED)", async () => {
    const useCase = new GetOrderUseCase(repo(), audit, idGen, logger);
    await expect(
      useCase.execute({ orderId: "order-1", actorId: "customer-2" }),
    ).rejectsWithCode("PERMISSION_DENIED");
  });

  it("rejects a missing order with RESOURCE_NOT_FOUND", async () => {
    const useCase = new GetOrderUseCase(repo(), audit, idGen, logger);
    await expect(useCase.execute({ orderId: "missing-1" })).rejectsWithCode("RESOURCE_NOT_FOUND");
  });
});

describe("GetCustomerProfileUseCase — read semantics", () => {
  const audit = new InMemoryAuditLogService();
  const idGen = new SequenceIdGenerator();
  const logger = new NoopLogger();

  function repo(): InMemoryCustomerRepository {
    const repository = new InMemoryCustomerRepository();
    repository.seed(
      new Customer({
        id: "customer-1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      }),
    );
    return repository;
  }

  it("returns the profile for the JWT identity", async () => {
    const useCase = new GetCustomerProfileUseCase(repo(), audit, idGen, logger);
    const customer = await useCase.execute({ customerId: "customer-1", actorId: "customer-1" });
    expect(customer.email).toBe("ada@example.com");
    expect(audit.actions().some((action) => action === "CUSTOMER_PROFILE_RETRIEVED")).toBe(true);
  });

  it("rejects a missing customer with RESOURCE_NOT_FOUND", async () => {
    const useCase = new GetCustomerProfileUseCase(repo(), audit, idGen, logger);
    await expect(
      useCase.execute({ customerId: "missing-1", actorId: "missing-1" }),
    ).rejectsWithCode("RESOURCE_NOT_FOUND");
  });

  it("rejects a blank customerId with VALIDATION_ERROR", async () => {
    const useCase = new GetCustomerProfileUseCase(repo(), audit, idGen, logger);
    await expect(useCase.execute({ customerId: "  " })).rejectsWithCode("VALIDATION_ERROR");
  });
});

describe("GetCustomerAddressesUseCase — read semantics", () => {
  const audit = new InMemoryAuditLogService();
  const idGen = new SequenceIdGenerator();
  const logger = new NoopLogger();

  function repo(): InMemoryCustomerRepository {
    const repository = new InMemoryCustomerRepository();
    repository.seed(
      new Customer({
        id: "customer-1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        addresses: [
          {
            id: "addr-1",
            customerId: "customer-1",
            street: "Main St",
            city: "Lagos",
            region: "LA",
            countryCode: "NG",
            postalCode: "100001",
            isDefault: true,
            createdAt: "2026-08-20T00:00:00.000Z",
          },
        ],
      }),
    );
    return repository;
  }

  it("returns the address book for the JWT identity", async () => {
    const useCase = new GetCustomerAddressesUseCase(repo(), audit, idGen, logger);
    const addresses = await useCase.execute({ customerId: "customer-1", actorId: "customer-1" });
    expect(addresses).toHaveLength(1);
    expect(addresses[0].id).toBe("addr-1");
    expect(audit.actions().some((action) => action === "CUSTOMER_ADDRESSES_RETRIEVED")).toBe(true);
  });

  it("rejects a missing customer with RESOURCE_NOT_FOUND", async () => {
    const useCase = new GetCustomerAddressesUseCase(repo(), audit, idGen, logger);
    await expect(
      useCase.execute({ customerId: "missing-1", actorId: "missing-1" }),
    ).rejectsWithCode("RESOURCE_NOT_FOUND");
  });

  it("rejects a blank customerId with VALIDATION_ERROR", async () => {
    const useCase = new GetCustomerAddressesUseCase(repo(), audit, idGen, logger);
    await expect(useCase.execute({ customerId: "" })).rejectsWithCode("VALIDATION_ERROR");
  });
});