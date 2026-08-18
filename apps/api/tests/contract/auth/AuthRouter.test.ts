// apps/api/tests/contract/auth/AuthRouter.test.ts
//
// HTTP CONTRACT TESTS — POST /store/auth and POST /store/customers/logout.
//
// The transport boundary must:
//   - accept ONLY { email, password } on auth (additionalProperties: false); a
//     client-supplied identity/token/metadata field is rejected with 400.
//   - map credential outcomes to the canonical statuses: INVALID_CREDENTIALS
//     401, ACCOUNT_LOCKED 423, ACCOUNT_DISABLED 403.
//   - require a valid bearer token on logout and revoke the RAW presented
//     token (never a client-supplied identity or a separately-supplied token).
//   - never echo stack traces, tokens, or provider internals.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import express, { Express } from "express";
import type { AddressInfo } from "node:net";
import { createAuthRouter } from "@api/adapters/http/routers/AuthRouter";
import { FakeTokenService } from "../../fakes/FakeTokenService";
import { NoopLogger } from "../../fakes/NoopLogger";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { AuthenticateCustomerInput } from "@api/use-cases/customers/AuthenticateCustomerUseCase";
import type { RevokeCustomerSessionInput } from "@api/use-cases/customers/RevokeCustomerSessionUseCase";

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
    body: JSON.stringify(body),
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

interface AuthHarness {
  authenticateCustomer: {
    execute: (input: AuthenticateCustomerInput) => Promise<{ accessToken: string }>;
    calls: AuthenticateCustomerInput[];
  };
  revokeCustomerSession: {
    execute: (input: RevokeCustomerSessionInput) => Promise<void>;
    calls: RevokeCustomerSessionInput[];
  };
}

function buildHarness(
  authBehavior: (
    input: AuthenticateCustomerInput,
  ) => Promise<{ accessToken: string }>,
): AuthHarness {
  const authCalls: AuthenticateCustomerInput[] = [];
  const revokeCalls: RevokeCustomerSessionInput[] = [];
  return {
    authenticateCustomer: {
      async execute(input: AuthenticateCustomerInput) {
        authCalls.push({ ...input });
        return authBehavior(input);
      },
      get calls() {
        return authCalls;
      },
    },
    revokeCustomerSession: {
      async execute(input: RevokeCustomerSessionInput) {
        revokeCalls.push({ ...input });
      },
      get calls() {
        return revokeCalls;
      },
    },
  };
}

function buildContractApp(harness: AuthHarness): Express {
  const app = express();
  app.use(
    "/store",
    createAuthRouter({
      authenticateCustomer: harness.authenticateCustomer as never,
      revokeCustomerSession: harness.revokeCustomerSession as never,
      tokenService: new FakeTokenService(new Map([["valid-token", VALID_CLAIMS]])),
      logger: new NoopLogger(),
    }),
  );
  return app;
}

describe("POST /store/auth — transport boundary", () => {
  it("200 with { accessToken } for valid credentials", async () => {
    const harness = buildHarness(async () => ({ accessToken: "issued-token" }));
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(server.baseUrl, "/store/auth", {
        email: "buyer@example.com",
        password: "secret",
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ accessToken: "issued-token" });
      expect(harness.authenticateCustomer.calls).toHaveLength(1);
      expect(harness.authenticateCustomer.calls[0].email).toBe("buyer@example.com");
      expect(harness.authenticateCustomer.calls[0].passwordRaw).toBe("secret");
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a client-supplied identity field", async () => {
    const harness = buildHarness(async () => ({ accessToken: "issued-token" }));
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(server.baseUrl, "/store/auth", {
        email: "buyer@example.com",
        password: "secret",
        customerId: "customer-999",
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: 'Unexpected field "customerId" in request body.',
        },
      });
      expect(harness.authenticateCustomer.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a missing required field", async () => {
    const harness = buildHarness(async () => ({ accessToken: "issued-token" }));
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(server.baseUrl, "/store/auth", {
        email: "buyer@example.com",
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "password is required." },
      });
      expect(harness.authenticateCustomer.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("401 INVALID_CREDENTIALS for bad credentials (never reveals which part failed)", async () => {
    const harness = buildHarness(async () => {
      throw new DomainError(
        "INVALID_CREDENTIALS",
        "Invalid email or password.",
      );
    });
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(server.baseUrl, "/store/auth", {
        email: "buyer@example.com",
        password: "wrong",
      });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." },
      });
    } finally {
      await server.close();
    }
  });

  it("423 ACCOUNT_LOCKED for a locked account", async () => {
    const harness = buildHarness(async () => {
      throw new DomainError(
        "ACCOUNT_LOCKED",
        "Account temporarily locked due to multiple failed login attempts.",
      );
    });
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(server.baseUrl, "/store/auth", {
        email: "buyer@example.com",
        password: "secret",
      });
      expect(response.status).toBe(423);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "ACCOUNT_LOCKED",
          message: "Account temporarily locked due to multiple failed login attempts.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("403 ACCOUNT_DISABLED for a disabled account", async () => {
    const harness = buildHarness(async () => {
      throw new DomainError("ACCOUNT_DISABLED", "This account has been disabled.");
    });
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(server.baseUrl, "/store/auth", {
        email: "buyer@example.com",
        password: "secret",
      });
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        success: false,
        error: { code: "ACCOUNT_DISABLED", message: "This account has been disabled." },
      });
    } finally {
      await server.close();
    }
  });
});

describe("POST /store/customers/logout — session revocation boundary", () => {
  it("204 revokes the RAW presented token with the token's own identity", async () => {
    const harness = buildHarness(async () => ({ accessToken: "issued-token" }));
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/customers/logout",
        {},
        "valid-token",
      );
      expect(response.status).toBe(204);
      expect(harness.revokeCustomerSession.calls).toHaveLength(1);
      expect(harness.revokeCustomerSession.calls[0].activeToken).toBe("valid-token");
      expect(harness.revokeCustomerSession.calls[0].actorId).toBe("customer-1");
    } finally {
      await server.close();
    }
  });

  it("401 UNAUTHORIZED_ACCESS without a bearer token", async () => {
    const harness = buildHarness(async () => ({ accessToken: "issued-token" }));
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(server.baseUrl, "/store/customers/logout", {});
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: { code: "UNAUTHORIZED_ACCESS", message: "Authentication required." },
      });
      expect(harness.revokeCustomerSession.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("401 UNAUTHORIZED_ACCESS for an invalid bearer token", async () => {
    const harness = buildHarness(async () => ({ accessToken: "issued-token" }));
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/customers/logout",
        {},
        "forged-token",
      );
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: { code: "UNAUTHORIZED_ACCESS", message: "Invalid or expired token." },
      });
      expect(harness.revokeCustomerSession.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a client-supplied identity field", async () => {
    const harness = buildHarness(async () => ({ accessToken: "issued-token" }));
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/customers/logout",
        { customerId: "customer-999" },
        "valid-token",
      );
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: 'Unexpected field "customerId" in request body.',
        },
      });
      expect(harness.revokeCustomerSession.calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("204 forwards the optional revocation reason to the use case", async () => {
    const harness = buildHarness(async () => ({ accessToken: "issued-token" }));
    const server = await startServer(buildContractApp(harness));
    try {
      const response = await postJson(
        server.baseUrl,
        "/store/customers/logout",
        { reason: "MANUAL_REVOCATION" },
        "valid-token",
      );
      expect(response.status).toBe(204);
      expect(harness.revokeCustomerSession.calls[0].reason).toBe("MANUAL_REVOCATION");
    } finally {
      await server.close();
    }
  });
});
