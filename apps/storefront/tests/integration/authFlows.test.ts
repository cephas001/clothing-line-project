// apps/storefront/tests/integration/authFlows.test.ts
//
// Authentication flows through the real service layer: token store round-trip,
// login/register response parsing, guest fallback on 401 (the AuthContext
// treats a 401 on /me as "not signed in"), and bearer injection on getMe.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { isApiError } from "../../src/lib/api/errors";
import {
  clearToken,
  getToken,
  hasToken,
  setToken,
} from "../../src/lib/api/auth";
import {
  getMe,
  login,
  logout,
  register,
} from "../../src/lib/api/customers";
import { testServer } from "../helpers/testServer";
import { resetClientStorage } from "../helpers/env";
import {
  makeAuthResponse,
  makeCustomer,
} from "../helpers/fixtures";

describe("bearer token store", () => {
  it("round-trips set/get/has and clear", () => {
    resetClientStorage();
    expect(getToken()).toBeNull();
    expect(hasToken()).toBe(false);
    setToken("jwt.test.token");
    expect(getToken()).toBe("jwt.test.token");
    expect(hasToken()).toBe(true);
    clearToken();
    expect(getToken()).toBeNull();
    expect(hasToken()).toBe(false);
  });
});

describe("authentication service layer", () => {
  it("login posts credentials and parses the accessToken", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/auth", () => {
      return { status: 200, body: makeAuthResponse({ accessToken: "jwt.login" }) };
    });
    const result = await login({ email: "ada@example.test", password: "secret" });
    expect(result.accessToken).toBe("jwt.login");
    const req = testServer.last();
    expect(req?.body).toEqual({ email: "ada@example.test", password: "secret" });
  });

  it("login surfaces INVALID_CREDENTIALS from the canonical envelope", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/auth", () => ({
      status: 401,
      body: { success: false, error: { code: "INVALID_CREDENTIALS", message: "Bad credentials." } },
    }));
    let thrown: unknown;
    try {
      await login({ email: "ada@example.test", password: "wrong" });
    } catch (err) {
      thrown = err;
    }
    expect(isApiError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("INVALID_CREDENTIALS");
  });

  it("register posts the customer payload and parses the Customer", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/customers", () => ({
      status: 201,
      body: makeCustomer({ email: "new@example.test" }),
    }));
    const result = await register({
      firstName: "New",
      lastName: "User",
      email: "new@example.test",
      password: "secret",
    });
    expect(result.email).toBe("new@example.test");
  });

  it("getMe without a token gets a 401 ApiError (guest fallback path)", async () => {
    await testServer.listen();
    testServer.clearReceived();
    clearToken();
    testServer.when("GET", "/store/customers/me", () => ({
      status: 401,
      body: { success: false, error: { code: "UNAUTHORIZED", message: "Sign in required." } },
    }));
    let thrown: unknown;
    try {
      await getMe();
    } catch (err) {
      thrown = err;
    }
    expect(isApiError(thrown)).toBe(true);
    expect((thrown as { status: number }).status).toBe(401);
  });

  it("getMe with a token attaches Authorization and parses the Customer", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.test.token");
    testServer.when("GET", "/store/customers/me", () => ({
      status: 200,
      body: makeCustomer({ email: "ada@example.test" }),
    }));
    const me = await getMe();
    expect(me.email).toBe("ada@example.test");
    expect(testServer.last()?.headers["authorization"]).toBe("Bearer jwt.test.token");
    clearToken();
  });

  it("logout posts and resolves on 204", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.test.token");
    testServer.when("POST", "/store/customers/logout", () => ({ status: 204 }));
    const result = await logout();
    expect(result).toBeUndefined();
    expect(testServer.last()?.method).toBe("POST");
    clearToken();
  });
});