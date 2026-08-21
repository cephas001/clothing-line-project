// apps/storefront/tests/integration/apiClient.test.ts
//
// API client transport + parsing (src/lib/api/client.ts) exercised over REAL
// HTTP against an in-process server. Verifies JSON parsing, 204 handling,
// the canonical error-envelope -> ApiError mapping, non-JSON error fallback,
// storefront-context header injection and bearer-token injection.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { ApiError, isApiError } from "../../src/lib/api/errors";
import { request } from "../../src/lib/api/client";
import { testServer } from "../helpers/testServer";
import { setToken, clearToken } from "../../src/lib/api/auth";

describe("api client transport + parsing", () => {
  it("parses a JSON GET response", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("GET", "/store/thing", () => ({
      status: 200,
      body: { ok: true, count: 3 },
    }));
    const data = await request<{ ok: boolean; count: number }>("/store/thing");
    expect(data.ok).toBe(true);
    expect(data.count).toBe(3);
    const req = testServer.last();
    expect(req?.method).toBe("GET");
    expect(req?.path).toBe("/store/thing");
  });

  it("treats a 204 response as undefined", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("DELETE", "/store/thing/1", () => ({ status: 204 }));
    const data = await request<void>("/store/thing/1", { method: "DELETE" });
    expect(data).toBeUndefined();
  });

  it("maps a canonical error envelope to an ApiError with status + code", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("GET", "/store/protected", () => ({
      status: 401,
      body: { success: false, error: { code: "UNAUTHORIZED", message: "Token missing." } },
    }));
    let thrown: unknown;
    try {
      await request<unknown>("/store/protected", { auth: true });
    } catch (err) {
      thrown = err;
    }
    expect(isApiError(thrown)).toBe(true);
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(401);
    expect((thrown as ApiError).code).toBe("UNAUTHORIZED");
    expect((thrown as ApiError).message).toBe("Token missing.");
  });

  it("maps a non-JSON error body to UNKNOWN_ERROR while preserving the status", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("GET", "/store/broken", () => ({ status: 502, body: "Bad Gateway" }));
    let thrown: unknown;
    try {
      await request<unknown>("/store/broken");
    } catch (err) {
      thrown = err;
    }
    expect(isApiError(thrown)).toBe(true);
    expect((thrown as ApiError).status).toBe(502);
    expect((thrown as ApiError).code).toBe("UNKNOWN_ERROR");
  });

  it("attaches storefront-context headers when storefrontContext is set", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("GET", "/store/products", () => ({
      status: 200,
      body: { items: [], total: 0 },
    }));
    await request<unknown>("/store/products", { storefrontContext: true });
    const req = testServer.last();
    expect(req?.headers["region_id"]).toBe("reg-test");
    expect(req?.headers["sales_channel_id"]).toBe("channel-test");
  });

  it("attaches the bearer token only when auth is requested and a token exists", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("GET", "/store/me", () => ({
      status: 200,
      body: { id: "c1" },
    }));

    clearToken();
    await request<unknown>("/store/me", { auth: true });
    expect(testServer.last()?.headers["authorization"]).toBeUndefined();

    setToken("jwt.test.token");
    await request<unknown>("/store/me", { auth: true });
    expect(testServer.last()?.headers["authorization"]).toBe("Bearer jwt.test.token");

    await request<unknown>("/store/me");
    expect(testServer.last()?.headers["authorization"]).toBeUndefined();
  });

  it("never attaches the bearer token on non-authenticated calls even when stored", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("GET", "/store/products", () => ({
      status: 200,
      body: { items: [], total: 0 },
    }));
    setToken("jwt.test.token");
    await request<unknown>("/store/products", { storefrontContext: true });
    expect(testServer.last()?.headers["authorization"]).toBeUndefined();
    clearToken();
  });
});