// apps/api/tests/contract/http/MiddlewareOrdering.test.ts
//
// HTTP CONTRACT TESTS — deterministic Express middleware ordering (Phase 18/15).
//
// The server's route-registration contract (apps/api/src/server.ts) is:
//   1. docs + health (no body parsing)
//   2. RAW-BODY webhook routers FIRST, before the global JSON parser — a
//      signature verifier must see the EXACT bytes, never a parsed object
//   3. global express.json for every storefront/admin JSON body
//   4. JSON routers
//   5. terminal JSON 404 + canonical error handler
//
// This suite mirrors that ordering and pins the invariants that keep webhook
// integrity intact and every response on the canonical envelope:
//   - a webhook mounted before the global parser receives a Buffer (raw bytes)
//     even when the client sends a JSON body with content-type application/json
//   - a JSON route mounted after the global parser receives a parsed object
//   - malformed JSON on a post-parser route -> 400 VALIDATION_ERROR envelope
//   - an unmatched route -> 404 RESOURCE_NOT_FOUND envelope (never HTML)
//   - a bad webhook signature -> 401 PAYMENT_VERIFICATION_FAILED envelope via
//     the shared canonical error pipeline (not a webhook-local mapper)

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import express, { Express } from "express";
import type { AddressInfo } from "node:net";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { createPaymentWebhookRouter } from "@api/adapters/http/routers/PaymentWebhookRouter";
import {
  createNotFoundHandler,
  createTerminalErrorHandler,
} from "@api/adapters/http/errors";
import { NoopLogger } from "../../fakes/NoopLogger";

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
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const finalHeaders: Record<string, string> = { ...headers };
  if (body !== undefined) {
    finalHeaders["content-type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: finalHeaders,
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

/**
 * Build an app that mirrors apps/api/src/server.ts registration order exactly:
 * raw-body webhook router first, then the global JSON parser, then a JSON
 * route, then the terminal 404 + error handlers.
 */
function buildOrderedApp(): {
  app: Express;
  captured: { rawWebhookBody: unknown; jsonRouteBody: unknown };
  signatureHeader: string;
} {
  const captured = { rawWebhookBody: undefined as unknown, jsonRouteBody: undefined as unknown };

  const webhookRouter = createPaymentWebhookRouter({
    verifySignature: {
      execute(input: { rawBody: Buffer; signatureHeader: string }): void {
        if (input.signatureHeader !== "valid-signature") {
          throw new DomainError(
            "PAYMENT_VERIFICATION_FAILED",
            "Signature verification failed.",
          );
        }
      },
    } as never,
    queuePaymentEvent: {
      async execute(): Promise<void> {},
    } as never,
    mapper: {
      async parseAndMap(rawBody: Buffer) {
        // Record the EXACT bytes the handler received. If the global JSON
        // parser ran before this router, this would be a zero-length Buffer.
        captured.rawWebhookBody = Buffer.isBuffer(rawBody)
          ? rawBody.toString("utf8")
          : rawBody;
        return { handled: false, eventType: "charge.success" };
      },
    } as never,
    webhookSecret: "test-secret",
    logger: new NoopLogger(),
  });

  const app = express();

  // Step 2 of the contract: raw-body webhook BEFORE the global JSON parser.
  app.use("/store/payments/webhook", webhookRouter);

  // Step 3: global JSON parser for every storefront/admin JSON body.
  app.use(express.json({ limit: "100kb" }));

  // Step 4: a JSON route that echoes whether its body arrived as a parsed object.
  app.post("/store/json/echo", (req, res) => {
    captured.jsonRouteBody = req.body;
    res.status(200).json({ ok: true, parsed: typeof req.body === "object" && !Buffer.isBuffer(req.body) });
  });

  // Step 5: terminal handlers.
  app.use(createNotFoundHandler(new NoopLogger()));
  app.use(createTerminalErrorHandler(new NoopLogger()));

  return { app, captured, signatureHeader: "valid-signature" };
}

describe("Deterministic middleware ordering (raw webhooks before global JSON parser)", () => {
  it("a webhook mounted BEFORE the global parser receives the raw bytes as a Buffer", async () => {
    const { app, captured, signatureHeader } = buildOrderedApp();
    const server = await startServer(app);
    try {
      const response = await send(
        server.baseUrl,
        "/store/payments/webhook",
        { event: "charge.success", data: { reference: "ref-1" } },
        { "x-paystack-signature": signatureHeader },
      );
      expect(response.status).toBe(200);
      // The handler saw the exact raw JSON bytes, not a parsed object and not
      // an empty stream — proving the global JSON parser did not consume the
      // body before the webhook ran.
      expect(captured.rawWebhookBody).toBe(
        JSON.stringify({ event: "charge.success", data: { reference: "ref-1" } }),
      );
    } finally {
      await server.close();
    }
  });

  it("a bad webhook signature is answered 401 on the canonical envelope", async () => {
    const { app } = buildOrderedApp();
    const server = await startServer(app);
    try {
      const response = await send(
        server.baseUrl,
        "/store/payments/webhook",
        { event: "charge.success" },
        { "x-paystack-signature": "tampered" },
      );
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "PAYMENT_VERIFICATION_FAILED",
          message: "Signature verification failed.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("a JSON route mounted AFTER the global parser receives a parsed object", async () => {
    const { app, captured } = buildOrderedApp();
    const server = await startServer(app);
    try {
      const response = await send(server.baseUrl, "/store/json/echo", {
        item: "shirt",
        qty: 2,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, parsed: true });
      expect(captured.jsonRouteBody).toEqual({ item: "shirt", qty: 2 });
    } finally {
      await server.close();
    }
  });

  it("malformed JSON on a post-parser route -> 400 VALIDATION_ERROR envelope", async () => {
    const { app } = buildOrderedApp();
    const server = await startServer(app);
    try {
      const response = await fetch(`${server.baseUrl}/store/json/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not valid json",
      });
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(400);
      expect(body).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body is not valid JSON.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("an unmatched route -> 404 RESOURCE_NOT_FOUND envelope (never HTML)", async () => {
    const { app } = buildOrderedApp();
    const server = await startServer(app);
    try {
      const response = await send(server.baseUrl, "/store/nope");
      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect((response.body.error as Record<string, unknown>).code).toBe(
        "RESOURCE_NOT_FOUND",
      );
    } finally {
      await server.close();
    }
  });
});