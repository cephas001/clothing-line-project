// apps/api/tests/contract/payment/PaymentSessionTampering.test.ts
//
// HTTP CONTRACT TESTS — POST /store/carts/{id}/payment-sessions.
//
// The transport boundary must reject EVERY forbidden financial/identity field
// before the use case is reached. A tampered request must NEVER create a
// payment obligation or contact the gateway. The only accepted body key is
// `returnUrl` (OpenAPI: PaymentSessionRequest, additionalProperties: false).
//
// Assertion targets:
//   - 400 VALIDATION_ERROR with "Unexpected field" for each forbidden field
//     (amountMinor, totalMinor, currency, discountMinor, taxMinor,
//     shippingMinor, insuranceMinor, paymentReference, reference,
//     providerReference, customerId, paymentStatus, ...).
//   - after every tampered request: NO payment obligation row, NO gateway call,
//     cart still NOT payment-initialized.
//   - positive control: `{ returnUrl }` initializes with the server-authoritative
//     amount and returns ONLY authorizationUrl + reference.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import express, { Express } from "express";
import type { AddressInfo } from "node:net";
import { createPaymentInitializationRouter } from "@api/adapters/http/PaymentInitializationRouter";
import { createPaymentHarness } from "../../integration/payment/harness";
import { FakeTokenService } from "../../fakes/FakeTokenService";
import { NoopLogger } from "../../fakes/NoopLogger";
import type { PaymentHarness } from "../../integration/payment/harness";

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
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

async function postRaw(
  baseUrl: string,
  path: string,
  rawBody: string,
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

interface ContractApp {
  app: Express;
  harness: PaymentHarness;
}

function buildContractApp(): ContractApp {
  const harness = createPaymentHarness();
  const app = express();
  app.use(
    "/store/carts",
    createPaymentInitializationRouter({
      initializePaymentSession: harness.initializePaymentSession,
      tokenService: new FakeTokenService(),
      logger: new NoopLogger(),
    }),
  );
  return { app, harness };
}

/** Forbidden client-supplied fields the boundary must reject. */
const FORBIDDEN_FIELDS: Array<[field: string, value: unknown]> = [
  ["amountMinor", 61000],
  ["totalMinor", 61000],
  ["total", 61000],
  ["amount", 61000],
  ["currency", "usd"],
  ["discountMinor", 0],
  ["discount", 0],
  ["taxMinor", 0],
  ["tax", 0],
  ["shippingMinor", 0],
  ["shipping", 0],
  ["insuranceMinor", 0],
  ["insurance", 0],
  ["paymentReference", "CLP-checkout-forged"],
  ["reference", "CLP-checkout-forged"],
  ["providerReference", "pay-forged"],
  ["customerId", "customer-999"],
  ["customer", "customer-999"],
  ["paymentStatus", "paid"],
  ["status", "captured"],
  ["metadata", { forged: true }],
  ["authorizationUrl", "https://evil.example/charge"],
];

describe("POST /store/carts/{id}/payment-sessions — client financial tampering", () => {
  for (const [field, value] of FORBIDDEN_FIELDS) {
    it(`rejects injected field "${field}" with 400 VALIDATION_ERROR and no side effects`, async () => {
      const { app, harness } = buildContractApp();
      const server = await startServer(app);
      try {
        const response = await postJson(
          server.baseUrl,
          "/store/carts/cart-1/payment-sessions",
          { [field]: value },
        );

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(
          (response.body.error as { code?: unknown }).code,
        ).toBe("VALIDATION_ERROR");
        expect(
          (response.body.error as { message?: unknown }).message,
        ).toContain("Unexpected field");

        // The tampered request produced NO financial side effect.
        expect(harness.paymentRepository.isEmpty()).toBe(true);
        expect(harness.paymentService.checkoutInitializations).toHaveLength(0);
        expect(harness.cart.paymentInitialized).toBe(false);
      } finally {
        await server.close();
      }
    });
  }

  it("rejects a financial field even when the allowed returnUrl is also present", async () => {
    const { app, harness } = buildContractApp();
    const server = await startServer(app);
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/carts/cart-1/payment-sessions",
        { returnUrl: "https://shop.example/callback", amountMinor: 1 },
      );

      expect(response.status).toBe(400);
      expect(harness.paymentService.checkoutInitializations).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a non-object body (array and string)", async () => {
    const { app, harness } = buildContractApp();
    const server = await startServer(app);
    try {
      const arrayResponse = await postJson(
        server.baseUrl,
        "/store/carts/cart-1/payment-sessions",
        [1, 2, 3],
      );
      expect(arrayResponse.status).toBe(400);
      expect(
        (arrayResponse.body.error as { code?: unknown }).code,
      ).toBe("VALIDATION_ERROR");

      const stringResponse = await postJson(
        server.baseUrl,
        "/store/carts/cart-1/payment-sessions",
        "not-an-object",
      );
      expect(stringResponse.status).toBe(400);

      expect(harness.paymentService.checkoutInitializations).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a wrong-typed returnUrl", async () => {
    const { app, harness } = buildContractApp();
    const server = await startServer(app);
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/carts/cart-1/payment-sessions",
        { returnUrl: 12345 },
      );

      expect(response.status).toBe(400);
      expect(
        (response.body.error as { code?: unknown }).code,
      ).toBe("VALIDATION_ERROR");
      expect(harness.paymentService.checkoutInitializations).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects an unparseable JSON body", async () => {
    const { app, harness } = buildContractApp();
    const server = await startServer(app);
    try {
      const response = await postRaw(
        server.baseUrl,
        "/store/carts/cart-1/payment-sessions",
        "{not valid json",
      );

      expect(response.status).toBe(400);
      expect(
        (response.body.error as { code?: unknown }).code,
      ).toBe("VALIDATION_ERROR");
      expect(harness.paymentService.checkoutInitializations).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("POST /store/carts/{id}/payment-sessions — positive control", () => {
  it("accepts ONLY returnUrl and initializes with the server-authoritative amount", async () => {
    const { app, harness } = buildContractApp();
    const server = await startServer(app);
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/carts/cart-1/payment-sessions",
        { returnUrl: "https://shop.example/callback" },
      );

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual([
        "authorizationUrl",
        "reference",
      ]);
      expect(response.body.reference).toBe("CLP-checkout-cart-1");
      expect(response.body.authorizationUrl).toBeDefined();

      // The gateway was asked for exactly the frozen authoritative amount.
      expect(harness.paymentService.checkoutInitializations).toHaveLength(1);
      expect(harness.paymentService.checkoutInitializations[0].amountMinor).toBe(
        61000,
      );
      expect(harness.paymentService.checkoutInitializations[0].currency).toBe(
        "ngn",
      );
      expect(harness.cart.paymentInitialized).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("returns 409 INVALID_OPERATION for an already-initialized cart (no re-charge)", async () => {
    const { app, harness } = buildContractApp();
    const server = await startServer(app);
    try {
      const first = await postJson(server.baseUrl, "/store/carts/cart-1/payment-sessions", {});
      expect(first.status).toBe(200);

      const second = await postJson(server.baseUrl, "/store/carts/cart-1/payment-sessions", {});

      // The durable cart mirror was persisted, so the repeat request is
      // rejected — the gateway is NEVER asked to charge twice.
      expect(second.status).toBe(409);
      expect(
        (second.body.error as { code?: unknown }).code,
      ).toBe("INVALID_OPERATION");
      expect(harness.paymentService.checkoutInitializations).toHaveLength(1);
      expect(harness.paymentRepository.all).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});