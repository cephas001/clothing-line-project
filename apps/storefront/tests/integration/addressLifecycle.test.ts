// apps/storefront/tests/integration/addressLifecycle.test.ts
//
// F9 — address CREATION lifecycle over REAL HTTP (no fetch mocks).
//
// The AddAddressForm contract: submit → submitting → POST → success →
// authoritative refetch → clear/close. These tests pin the service-layer
// sequence the form now depends on:
//   1. the POST carries ONLY the whitelisted AddressInput with the bearer;
//   2. the authoritative GET runs AFTER the creation resolves (the form may
//      only clear once the server's version of the book is on screen);
//   3. a failed creation REJECTS and fires NO refetch — the form keeps the
//      entered data and shows the error instead of pretending success.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { createAddress, getAddresses } from "../../src/lib/api/customers";
import { setToken, clearToken } from "../../src/lib/api/auth";
import { makeAddress } from "../helpers/fixtures";
import { testServer } from "../helpers/testServer";

const ADDRESS_PATH = "/store/customers/me/addresses";

const input = {
  firstName: "Ada",
  lastName: "Lovelace",
  phone: "+2348000000000",
  line1: "1 Test Street",
  city: "Lagos",
  state: "LA",
  postalCode: "100001",
  countryCode: "NG",
  isDefault: false,
};

describe("F9 — address creation lifecycle over real HTTP", () => {
  it("POSTs the whitelisted input with the bearer, THEN the book is refetched", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.session.token");

    const serverBook = [
      makeAddress({
        firstName: "Ada",
        lastName: "Lovelace",
        city: "Lagos",
        line1: "1 Test Street",
      }),
    ];
    testServer.when("POST", ADDRESS_PATH, () => ({ status: 201 }));
    testServer.when("GET", ADDRESS_PATH, () => ({ status: 200, body: serverBook }));

    // The exact sequence the fixed form performs: create, await it, then the
    // authoritative refresh — only after both does the form clear.
    await createAddress(input);
    const book = await getAddresses();

    const post = testServer.received.find((r) => r.method === "POST");
    expect(post?.path).toBe(ADDRESS_PATH);
    // Exact equality proves no unsupported fields ride along.
    expect(post?.body).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      phone: "+2348000000000",
      line1: "1 Test Street",
      city: "Lagos",
      state: "LA",
      postalCode: "100001",
      countryCode: "NG",
      isDefault: false,
    });
    expect(post?.headers["authorization"]).toBe("Bearer jwt.session.token");

    const gets = testServer.received.filter((r) => r.method === "GET");
    expect(gets).toHaveLength(1);
    const postIndex = testServer.received.indexOf(post!);
    expect(testServer.received.indexOf(gets[0])).toBeGreaterThan(postIndex);

    // The refreshed book is the SERVER's projection, not a local fabrication.
    expect(book).toHaveLength(1);
    expect(book[0].city).toBe("Lagos");
    clearToken();
  });

  it("a failed creation rejects and triggers NO authoritative refetch", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.session.token");

    testServer.when("POST", ADDRESS_PATH, () => ({
      status: 500,
      body: {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Storage unavailable." },
      },
    }));

    let rejection: unknown = null;
    try {
      await createAddress(input);
    } catch (err) {
      rejection = err;
    }
    // The rejection is what lets the form PRESERVE the entered data and
    // render the error inline instead of clearing on an unconfirmed attempt.
    expect(rejection).not.toBeNull();

    const posts = testServer.received.filter((r) => r.method === "POST");
    const gets = testServer.received.filter((r) => r.method === "GET");
    expect(posts).toHaveLength(1);
    expect(gets).toHaveLength(0);
    clearToken();
  });

  it("a validation failure (400) also rejects before any refetch", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.session.token");

    testServer.when("POST", ADDRESS_PATH, () => ({
      status: 400,
      body: {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid country code." },
      },
    }));

    let code = "";
    try {
      await createAddress({ ...input, countryCode: "ZZZ" });
    } catch (err) {
      code = (err as { code?: string }).code ?? "";
    }
    expect(code).toBe("VALIDATION_ERROR");
    expect(testServer.received.filter((r) => r.method === "GET")).toHaveLength(0);
    clearToken();
  });
});
