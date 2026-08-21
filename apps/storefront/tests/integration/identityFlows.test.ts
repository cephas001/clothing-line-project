// apps/storefront/tests/integration/identityFlows.test.ts
//
// Slice 3 over REAL HTTP (no fetch mocks):
//   G006 — password reset: initiate posts ONLY {email} (public route, no
//          bearer) and resolves 204; API errors surface as ApiError; complete
//          posts ONLY {resetToken, newPassword}; an invalid token surfaces the
//          server's 401 UNAUTHORIZED_ACCESS; after a successful complete the
//          stored credentials are the NEW ones (return-to-login works).
//   G007 — address editing: PUT carries the whitelisted AddressInput payload
//          (exact equality — no unsupported fields) with the bearer; after the
//          204 the list is REFETCHED and the UI shows the SERVER's version of
//          the address, never a locally fabricated one.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  completePasswordReset,
  getAddresses,
  initiatePasswordReset,
  updateAddress,
} from "../../src/lib/api/customers";
import { setToken, clearToken } from "../../src/lib/api/auth";
import { makeAddress } from "../helpers/fixtures";
import { testServer } from "../helpers/testServer";

describe("G006 — password reset over real HTTP", () => {
  it("initiate posts ONLY {email} on the public route and resolves 204", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.stale.token"); // must NOT be attached to the public route
    testServer.when("POST", "/store/customers/password-reset/initiate", () => ({
      status: 204,
    }));

    await initiatePasswordReset("ada@example.com");

    const req = testServer.last();
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/store/customers/password-reset/initiate");
    expect(req?.body).toEqual({ email: "ada@example.com" });
    expect(req?.headers["authorization"]).toBeUndefined();
    clearToken();
  });

  it("initiate surfaces a 400 envelope error as an ApiError", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/customers/password-reset/initiate", () => ({
      status: 400,
      body: {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid email." },
      },
    }));
    await expect(
      () => initiatePasswordReset("nope"),
    ).rejectsWithCode("VALIDATION_ERROR");
  });

  it("complete posts ONLY {resetToken, newPassword} and resolves 204", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/customers/password-reset/complete", () => ({
      status: 204,
    }));

    await completePasswordReset("token-from-email", "newPassword123");

    const req = testServer.last();
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/store/customers/password-reset/complete");
    // Exact equality proves no extra fields ride along.
    expect(req?.body).toEqual({
      resetToken: "token-from-email",
      newPassword: "newPassword123",
    });
  });

  it("an invalid/expired token surfaces the server's UNAUTHORIZED_ACCESS", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/customers/password-reset/complete", () => ({
      status: 401,
      body: {
        success: false,
        error: { code: "UNAUTHORIZED_ACCESS", message: "Invalid or expired reset token." },
      },
    }));
    await expect(
      () => completePasswordReset("bad-token", "newPassword123"),
    ).rejectsWithCode("UNAUTHORIZED_ACCESS");
  });

  it("after a successful complete, sign-in works with the NEW password", async () => {
    await testServer.listen();
    testServer.clearReceived();

    let completed = false;
    testServer.when("POST", "/store/customers/password-reset/complete", () => {
      completed = true;
      return { status: 204 };
    });
    testServer.when("POST", "/store/auth", (ctx) => {
      const body = ctx.body as { email?: string; password?: string };
      if (completed && body.password === "newPassword123") {
        return { status: 200, body: { accessToken: "jwt.new.session" } };
      }
      return {
        status: 401,
        body: { success: false, error: { code: "INVALID_CREDENTIALS", message: "Nope." } },
      };
    });

    await completePasswordReset("token-from-email", "newPassword123");
    const { login } = await import("../../src/lib/api/customers");
    const session = await login({
      email: "ada@example.com",
      password: "newPassword123",
    });
    expect(session.accessToken).toBe("jwt.new.session");
  });
});

describe("G007 — address editing over real HTTP", () => {
  it("PUTs the whitelisted payload with the bearer, then refetches the SERVER truth", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.address.token");

    // The server-side record BEFORE the edit…
    const stored = makeAddress({
      id: "addr-edit-1",
      firstName: "Ada",
      lastName: "Lovelace",
      line1: "1 Test Street",
      city: "Lagos",
      state: "LA",
      postalCode: "100001",
      countryCode: "NG",
      phone: "+2348000000000",
      isDefault: true,
    });
    let serverCopy = { ...stored };

    testServer.when("GET", "/store/customers/me/addresses", () => ({
      status: 200,
      body: [serverCopy],
    }));
    testServer.when("PUT", "/store/customers/me/addresses/addr-edit-1", (ctx) => {
      // The backend merges AddressInput fields into the stored entry.
      serverCopy = { ...serverCopy, ...(ctx.body as Record<string, unknown>) };
      return { status: 204 };
    });

    // 1. Preload from the existing server address.
    const current = (await getAddresses())[0];

    // 2. Save edited fields through the whitelist builder.
    const { editFormToAddressInput, addressToEditForm } = await import(
      "../../src/lib/addressEdit"
    );
    const form = addressToEditForm(current);
    form.line1 = "9 Edited Avenue";
    form.city = "Abuja";
    const payload = editFormToAddressInput(form, current);

    await updateAddress(current.id, payload);
    const putReq = testServer.received.find(
      (r) => r.method === "PUT" && r.path === "/store/customers/me/addresses/addr-edit-1",
    );
    expect(putReq?.headers["authorization"]).toBe("Bearer jwt.address.token");
    // Exact body equality — no unsupported fields posted. The cleared
    // optional `line2` is OMITTED from the wire payload entirely (undefined
    // keys never serialize), which is exactly what the server receives.
    expect(putReq?.body).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      phone: "+2348000000000",
      line1: "9 Edited Avenue",
      city: "Abuja",
      state: "LA",
      postalCode: "100001",
      countryCode: "NG",
      isDefault: true,
    });

    // 3. Authoritative refetch AFTER the 204: the UI shows the server's
    //    merged record — not a locally fabricated projection of it.
    const refetched = (await getAddresses())[0];
    expect(refetched.line1).toBe("9 Edited Avenue");
    expect(refetched.city).toBe("Abuja");
    expect(refetched.id).toBe("addr-edit-1");
    clearToken();
  });

  it("a failed PUT leaves the stored address untouched (error surfaced)", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.address.token");
    const stored = makeAddress({ id: "addr-edit-2", city: "Lagos" });
    const serverCopy = { ...stored };

    testServer.when("GET", "/store/customers/me/addresses", () => ({
      status: 200,
      body: [serverCopy],
    }));
    testServer.when("PUT", "/store/customers/me/addresses/addr-edit-2", () => ({
      status: 400,
      body: {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid address." },
      },
    }));

    await expect(
      () =>
        updateAddress("addr-edit-2", {
          line1: "X",
          city: "Y",
          countryCode: "NG",
          isDefault: false,
        }),
    ).rejectsWithCode("VALIDATION_ERROR");
    const unchanged = (await getAddresses())[0];
    expect(unchanged.city).toBe("Lagos");
    clearToken();
  });
});
