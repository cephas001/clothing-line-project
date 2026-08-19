// apps/api/tests/contract/logistics/SwapRouter.test.ts
//
// HTTP CONTRACT TESTS — POST /store/orders/:orderId/swaps (API-L1 Part 4).
//
// The transport boundary must:
//   - accept ONLY the SwapRequest identifiers (returnLineItemId,
//     returnQuantity, newVariantId, paymentRedirectBaseUrl); ANY injected
//     financial/identity field (amountMinor, currency, newVariantPriceMinor,
//     variance, customerId, actorId, ...) is rejected with 400 before the use
//     case is reached.
//   - derive the actor EXCLUSIVELY from the bearer JWT (never the body);
//     a forged/invalid token is 401, a foreign order is 403 PERMISSION_DENIED.
//   - map every outcome through the canonical error pipeline: the same
//     code->status table as every other router (no private switch that drifts).
//   - respond with the SwapResponse contract: 201 { swapId, variance, action,
//     paymentUrl }.
//   - NEVER leak provider/stack details: an unknown throw is a generic 500
//     INTERNAL_ERROR.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import express, { Express } from "express";
import type { AddressInfo } from "node:net";
import { createSwapRouter } from "@api/adapters/http/routers/SwapRouter";
import { FakeTokenService } from "../../fakes/FakeTokenService";
import { NoopLogger } from "../../fakes/NoopLogger";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ProcessOrderSwapVarianceInput } from "@api/use-cases/logistics/ProcessOrderSwapVarianceUseCase";

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

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  bearer?: string,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: response.status, body: parsed };
}

const VALID_CLAIMS = {
  customerId: "customer-1",
  email: "buyer@example.com",
  roles: [],
};

interface SwapUseCaseStub {
  execute: (input: ProcessOrderSwapVarianceInput) => Promise<{
    variance: number;
    action: "EVEN_EXCHANGE" | "PAYMENT_REQUIRED" | "REFUND_DISPATCHED";
    paymentUrl?: string | null;
    swapId: string;
  }>;
  calls: ProcessOrderSwapVarianceInput[];
}

function buildHarness(
  behavior: (input: ProcessOrderSwapVarianceInput) => Promise<{
    variance: number;
    action: "EVEN_EXCHANGE" | "PAYMENT_REQUIRED" | "REFUND_DISPATCHED";
    paymentUrl?: string | null;
    swapId: string;
  }>,
): SwapUseCaseStub {
  const calls: ProcessOrderSwapVarianceInput[] = [];
  return {
    async execute(input: ProcessOrderSwapVarianceInput) {
      calls.push({ ...input });
      return behavior(input);
    },
    get calls() {
      return calls;
    },
  };
}

function buildContractApp(
  stub: SwapUseCaseStub,
  claimsByToken: Map<string, typeof VALID_CLAIMS> = new Map([
    ["valid-token", VALID_CLAIMS],
  ]),
): Express {
  const app = express();
  app.use(
    "/store/orders",
    createSwapRouter({
      processOrderSwapVariance: stub as never,
      tokenService: new FakeTokenService(claimsByToken),
      logger: new NoopLogger(),
    }),
  );
  return app;
}

const VALID_SWAP_BODY = {
  returnLineItemId: "line-1",
  returnQuantity: 1,
  newVariantId: "variant-2",
};

const EVEN_RESULT = {
  swapId: "swap-1",
  variance: 0,
  action: "EVEN_EXCHANGE" as const,
  paymentUrl: null,
};

describe("POST /store/orders/{id}/swaps — client financial tampering", () => {
  const FORBIDDEN_FIELDS: Array<[field: string, value: unknown]> = [
    ["amountMinor", 61000],
    ["totalMinor", 61000],
    ["amount", 61000],
    ["currency", "usd"],
    ["variance", 3000],
    ["newVariantPriceMinor", 30000],
    ["replacementPriceMinor", 30000],
    ["paymentReference", "swap-forged"],
    ["providerReference", "pay-forged"],
    ["customerId", "customer-999"],
    ["actorId", "customer-999"],
    ["orderId", "order-999"],
    ["swapId", "swap-999"],
    ["paymentUrl", "https://evil.example/charge"],
    ["paymentStatus", "paid"],
  ];

  for (const [field, value] of FORBIDDEN_FIELDS) {
    it(`rejects injected field "${field}" with 400 VALIDATION_ERROR and no use-case call`, async () => {
      const stub = buildHarness(async () => EVEN_RESULT);
      const server = await startServer(buildContractApp(stub));
      try {
        const response = await postJson(
          server.baseUrl,
          "/store/orders/order-1/swaps",
          { ...VALID_SWAP_BODY, [field]: value },
        );
        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect((response.body.error as { code?: unknown }).code).toBe(
          "VALIDATION_ERROR",
        );
        expect((response.body.error as { message?: unknown }).message).toContain(
          "Unexpected field",
        );
        expect(stub.calls).toHaveLength(0);
      } finally {
        await server.close();
      }
    });
  }

  it("rejects a non-object body", async () => {
    const stub = buildHarness(async () => EVEN_RESULT);
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        [1, 2, 3],
      );
      expect(response.status).toBe(400);
      expect((response.body.error as { code?: unknown }).code).toBe(
        "VALIDATION_ERROR",
      );
      expect(stub.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a missing required identifier", async () => {
    const stub = buildHarness(async () => EVEN_RESULT);
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        { returnLineItemId: "line-1", returnQuantity: 1 },
      );
      expect(response.status).toBe(400);
      expect((response.body.error as { code?: unknown }).code).toBe(
        "VALIDATION_ERROR",
      );
      expect(stub.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a non-positive returnQuantity", async () => {
    const stub = buildHarness(async () => EVEN_RESULT);
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        { returnLineItemId: "line-1", returnQuantity: 0, newVariantId: "variant-2" },
      );
      expect(response.status).toBe(400);
      expect(stub.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects an unparseable JSON body with the canonical envelope", async () => {
    const stub = buildHarness(async () => EVEN_RESULT);
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        "{not valid json",
      );
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body is not valid JSON.",
        },
      });
      expect(stub.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("POST /store/orders/{id}/swaps — ownership and identity", () => {
  it("guest (no token) forwards actorId=undefined and processes the swap", async () => {
    const stub = buildHarness(async () => EVEN_RESULT);
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        VALID_SWAP_BODY,
      );
      expect(response.status).toBe(201);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].actorId).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("derives the actor from the bearer JWT, never from the body", async () => {
    const stub = buildHarness(async () => EVEN_RESULT);
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        VALID_SWAP_BODY,
        "valid-token",
      );
      expect(response.status).toBe(201);
      expect(stub.calls[0].actorId).toBe("customer-1");
    } finally {
      await server.close();
    }
  });

  it("401 UNAUTHORIZED_ACCESS for a forged bearer token (no use-case call)", async () => {
    const stub = buildHarness(async () => EVEN_RESULT);
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        VALID_SWAP_BODY,
        "forged-token",
      );
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: { code: "UNAUTHORIZED_ACCESS", message: "Invalid or expired token." },
      });
      expect(stub.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("403 PERMISSION_DENIED when the authenticated customer does not own the order", async () => {
    const stub = buildHarness(async () => {
      throw new DomainError(
        "PERMISSION_DENIED",
        "You do not have permission to swap this order.",
      );
    });
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        VALID_SWAP_BODY,
        "valid-token",
      );
      expect(response.status).toBe(403);
      expect((response.body.error as { code?: unknown }).code).toBe(
        "PERMISSION_DENIED",
      );
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].actorId).toBe("customer-1");
    } finally {
      await server.close();
    }
  });
});

describe("POST /store/orders/{id}/swaps — SwapResponse contract", () => {
  it("201 EVEN_EXCHANGE returns { swapId, variance: 0, action, paymentUrl: null }", async () => {
    const stub = buildHarness(async () => EVEN_RESULT);
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        VALID_SWAP_BODY,
      );
      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        swapId: "swap-1",
        variance: 0,
        action: "EVEN_EXCHANGE",
        paymentUrl: null,
      });
    } finally {
      await server.close();
    }
  });

  it("201 PAYMENT_REQUIRED returns the durable payment URL", async () => {
    const stub = buildHarness(async () => ({
      swapId: "swap-2",
      variance: 3000,
      action: "PAYMENT_REQUIRED" as const,
      paymentUrl: "https://pay.example/auth",
    }));
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        VALID_SWAP_BODY,
      );
      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        swapId: "swap-2",
        variance: 3000,
        action: "PAYMENT_REQUIRED",
        paymentUrl: "https://pay.example/auth",
      });
    } finally {
      await server.close();
    }
  });

  it("201 REFUND_DISPATCHED returns paymentUrl: null", async () => {
    const stub = buildHarness(async () => ({
      swapId: "swap-3",
      variance: -5000,
      action: "REFUND_DISPATCHED" as const,
      paymentUrl: null,
    }));
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        VALID_SWAP_BODY,
      );
      expect(response.status).toBe(201);
      expect(response.body.action).toBe("REFUND_DISPATCHED");
      expect(response.body.paymentUrl).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe("POST /store/orders/{id}/swaps — canonical error mapping", () => {
  const cases: Array<[code: string, status: number]> = [
    ["INVALID_OPERATION", 409],
    ["REGIONAL_PRICE_MISSING", 409],
    ["REFUND_REQUIRES_REVIEW", 409],
    ["INSUFFICIENT_INVENTORY", 409],
    ["INSUFFICIENT_SINGLE_LOCATION_STOCK", 409],
    ["RESOURCE_NOT_FOUND", 404],
    ["EXTERNAL_SERVICE_TIMEOUT", 500],
    ["INTERNAL_ERROR", 500],
  ];

  for (const [code, status] of cases) {
    it(`${code} -> ${status}`, async () => {
      const stub = buildHarness(async () => {
        throw new DomainError(code as never, `${code} message.`);
      });
      const server = await startServer(buildContractApp(stub));
      try {
        const response = await postJson(
          server.baseUrl,
          "/store/orders/order-1/swaps",
          VALID_SWAP_BODY,
        );
        expect(response.status).toBe(status);
        expect((response.body.error as { code?: unknown }).code).toBe(code);
      } finally {
        await server.close();
      }
    });
  }

  it("an unknown throw becomes a generic 500 and NEVER leaks the cause", async () => {
    const stub = buildHarness(async () => {
      throw new Error("paystack refused: sk_live_LEAK token at 10.0.0.5");
    });
    const server = await startServer(buildContractApp(stub));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/orders/order-1/swaps",
        VALID_SWAP_BODY,
      );
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Internal server error." },
      });
    } finally {
      await server.close();
    }
  });
});
