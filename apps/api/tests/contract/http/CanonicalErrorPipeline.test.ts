// apps/api/tests/contract/http/CanonicalErrorPipeline.test.ts
//
// UNIT + INTEGRATION TESTS for the canonical HTTP error pipeline
// (apps/api/src/adapters/http/errors.ts + middleware/body.ts), Phase 10.
//
// The pipeline guarantees:
//   - a single stable DomainError code -> status mapping (never a per-router
//     switch that drifts).
//   - an unknown/unexpected throw answers 500 INTERNAL_ERROR with a generic
//     message — the full cause is logged server-side, NEVER echoed (no stack
//     traces, SQL errors, provider bodies, tokens, or API keys).
//   - malformed JSON / oversized bodies map to VALIDATION_ERROR (400/413).
//   - unmatched routes answer a JSON 404 envelope, not Express HTML.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import express, { Express } from "express";
import type { AddressInfo } from "node:net";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { NoopLogger } from "../../fakes/NoopLogger";
import {
  mapDomainErrorToHttp,
  createNotFoundHandler,
  createTerminalErrorHandler,
} from "@api/adapters/http/errors";
import {
  parseStrictBodyObject,
  readQueryInt,
  readRequiredPathId,
  assertEmptyRequestBody,
} from "@api/adapters/http/middleware/body";

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

describe("mapDomainErrorToHttp — stable code->status table", () => {
  const cases: Array<[string, number]> = [
    ["VALIDATION_ERROR", 400],
    ["INVALID_INPUT", 400],
    ["UNSUPPORTED_OPERATION", 400],
    ["UNAUTHORIZED_ACCESS", 401],
    ["INVALID_CREDENTIALS", 401],
    ["INVALID_SIGNATURE", 401],
    ["PAYMENT_REQUIRED", 402],
    ["PERMISSION_DENIED", 403],
    ["UNAUTHORIZED_REVIEW", 403],
    ["ACCOUNT_DISABLED", 403],
    ["PRODUCT_NOT_FOUND", 404],
    ["CART_NOT_FOUND", 404],
    ["RESOURCE_NOT_FOUND", 404],
    ["INVALID_OPERATION", 409],
    ["INVALID_STATE", 409],
    ["OUT_OF_STOCK", 409],
    ["DUPLICATE_TRANSACTION", 409],
    ["INSUFFICIENT_INVENTORY", 409],
    ["INSUFFICIENT_SINGLE_LOCATION_STOCK", 409],
    ["REGIONAL_PRICE_MISSING", 409],
    ["REFUND_REQUIRES_REVIEW", 409],
    ["ACCOUNT_LOCKED", 423],
    ["INTERNAL_ERROR", 500],
    ["EXTERNAL_SERVICE_TIMEOUT", 500],
    ["SOURCING_FAILED", 500],
  ];

  for (const [code, status] of cases) {
    it(`${code} -> ${status}`, () => {
      const mapped = mapDomainErrorToHttp(
        new DomainError(code as never, "message"),
      );
      expect(mapped.status).toBe(status);
      expect(mapped.code).toBe(code);
      expect(mapped.message).toBe("message");
    });
  }

  it("an unknown DomainError code falls back to 500 but keeps its stable code", () => {
    const mapped = mapDomainErrorToHttp(
      new DomainError("INTERNAL_ERROR" as never, "boom"),
    );
    expect(mapped.status).toBe(500);
  });

  it("an unknown (non-DomainError) throw NEVER leaks the cause", () => {
    const mapped = mapDomainErrorToHttp(
      new Error("postgres: connection refused at 10.0.0.5:5432"),
    );
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.message).toBe("Internal server error.");
    expect(mapped.message).not.toContain("postgres");
  });
});

describe("terminal error handler — canonical envelope, no leaks", () => {
  it("unknown throws -> 500 INTERNAL_ERROR with a generic message", async () => {
    const app = express();
    app.use(express.json());
    app.get("/boom", () => {
      throw new Error("secret provider stack: PAYSTACK_SECRET_KEY=sk_live_xxx");
    });
    app.use(createTerminalErrorHandler(new NoopLogger()));
    const server = await startServer(app);
    try {
      const response = await fetch(`${server.baseUrl}/boom`);
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(500);
      expect(body).toEqual({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Internal server error." },
      });
    } finally {
      await server.close();
    }
  });

  it("DomainErrors -> canonical envelope with the mapped status", async () => {
    const app = express();
    app.use(express.json());
    app.get("/locked", () => {
      throw new DomainError("ACCOUNT_LOCKED", "Account locked.");
    });
    app.use(createTerminalErrorHandler(new NoopLogger()));
    const server = await startServer(app);
    try {
      const response = await fetch(`${server.baseUrl}/locked`);
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(423);
      expect(body).toEqual({
        success: false,
        error: { code: "ACCOUNT_LOCKED", message: "Account locked." },
      });
    } finally {
      await server.close();
    }
  });

  it("malformed JSON body -> 400 VALIDATION_ERROR", async () => {
    const app = express();
    app.use(express.json());
    app.post("/echo", (_req, res) => {
      res.json({ ok: true });
    });
    app.use(createTerminalErrorHandler(new NoopLogger()));
    const server = await startServer(app);
    try {
      const response = await fetch(`${server.baseUrl}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
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
});

describe("JSON 404 handler — every unmatched route speaks the envelope", () => {
  it("unmatched route -> 404 RESOURCE_NOT_FOUND JSON", async () => {
    const app = express();
    app.use(createNotFoundHandler(new NoopLogger()));
    app.use(createTerminalErrorHandler(new NoopLogger()));
    const server = await startServer(app);
    try {
      const response = await fetch(`${server.baseUrl}/no/such/route`);
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(404);
      expect(body).toEqual({
        success: false,
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "The requested endpoint was not found.",
        },
      });
    } finally {
      await server.close();
    }
  });
});

describe("canonical body-boundary helpers — strict by default", () => {
  it("parseStrictBodyObject rejects unexpected fields", () => {
    expect(() =>
      parseStrictBodyObject({ email: "a@b.com", password: "x", admin: true }, [
        "email",
        "password",
      ]),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("parseStrictBodyObject requires present non-blank required fields", () => {
    expect(() =>
      parseStrictBodyObject({ email: "" }, ["email", "password"], ["password"]),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("assertEmptyRequestBody rejects a non-empty body", () => {
    expect(() => assertEmptyRequestBody({ anything: 1 })).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("readRequiredPathId rejects a blank id", () => {
    expect(() => readRequiredPathId("  ", "cartId")).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("readQueryInt rejects a non-integer", () => {
    expect(() => readQueryInt("abc", "limit", 1, 200, 20)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("readQueryInt rejects an out-of-range value", () => {
    expect(() => readQueryInt("100000", "limit", 1, 200, 20)).toThrowWithCode(
      "VALIDATION_ERROR",
    );
  });

  it("readQueryInt returns the default for an absent value", () => {
    expect(readQueryInt(undefined, "limit", 1, 200, 20)).toBe(20);
  });
});
