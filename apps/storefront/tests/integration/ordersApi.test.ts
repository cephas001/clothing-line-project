// apps/storefront/tests/integration/ordersApi.test.ts
//
// Order + address service layer over real HTTP: paginated order history
// envelope, single-order read (bearer, ownership enforced server-side), address
// book list/add/update/delete, and the safe public Order projection consumed by
// the order-detail view (money fields + public fulfillment fields only).

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  createAddress,
  deleteAddress,
  getAddresses,
  getOrderHistory,
  updateAddress,
} from "../../src/lib/api/customers";
import { getOrder } from "../../src/lib/api/orders";
import { testServer } from "../helpers/testServer";
import { makeAddress, makeCustomer, makeOrder } from "../helpers/fixtures";
import { setToken, clearToken } from "../../src/lib/api/auth";

const CUSTOMER_ID = "cust-000";

describe("orders + address service layer", () => {
  it("getOrderHistory builds limit/offset and parses the { items, total } envelope", async () => {
    await testServer.listen();
    testServer.clearReceived();
    const order = makeOrder();
    testServer.when("GET", "/store/customers/me/orders", () => ({
      status: 200,
      body: { items: [order], total: 1 },
    }));
    const page = await getOrderHistory({ limit: 10, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    const query = new URLSearchParams(testServer.last()?.query ?? "");
    expect(query.get("limit")).toBe("10");
    expect(query.get("offset")).toBe("0");
  });

  it("getOrder reads with a bearer and parses the public Order projection", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.test.token");
    const order = makeOrder({ id: "ord-000", customerId: CUSTOMER_ID });
    testServer.when("GET", "/store/orders/ord-000", () => ({ status: 200, body: order }));
    const result = await getOrder("ord-000");
    expect(result.id).toBe("ord-000");
    expect(result.totalAmountMinor).toBe(order.totalAmountMinor);
    expect(result.subtotalMinor).toBe(order.subtotalMinor);
    expect(result.lineItems?.[0]?.unitPriceMinor).toBe(order.lineItems?.[0]?.unitPriceMinor);
    expect(result.fulfillments?.[0]?.trackingNumber).toBe("TRACK-001");
    expect(result.fulfillments?.[0]?.courier).toBe("Test Express");
    expect(result.fulfillments?.[0]?.status).toBe("in_transit");
    expect(testServer.last()?.headers["authorization"]).toBe("Bearer jwt.test.token");
    clearToken();
  });

  it("getOrder surfaces a foreign-order 403 as an ApiError (ownership enforced)", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.test.token");
    testServer.when("GET", "/store/orders/ord-other", () => ({
      status: 403,
      body: { success: false, error: { code: "FORBIDDEN", message: "Not your order." } },
    }));
    let thrown: unknown;
    try {
      await getOrder("ord-other");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { status?: number }).status).toBe(403);
    clearToken();
  });

  it("getAddresses parses the bare Address array", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("GET", "/store/customers/me/addresses", () => ({
      status: 200,
      body: [makeAddress({ id: "addr-1", isDefault: true })],
    }));
    const addresses = await getAddresses();
    expect(addresses).toHaveLength(1);
    expect(addresses[0].isDefault).toBe(true);
  });

  it("createAddress POSTs an AddressInput and resolves on 204", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("POST", "/store/customers/me/addresses", () => ({ status: 204 }));
    const result = await createAddress({
      firstName: "Ada",
      lastName: "Lovelace",
      line1: "1 Test Street",
      city: "Lagos",
      state: "LA",
      postalCode: "100001",
      countryCode: "NG",
      isDefault: false,
    });
    expect(result).toBeUndefined();
    const req = testServer.last();
    expect(req?.body).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      line1: "1 Test Street",
      city: "Lagos",
      state: "LA",
      postalCode: "100001",
      countryCode: "NG",
      isDefault: false,
    });
  });

  it("updateAddress PUTs to the address path and deleteAddress DELETEs it", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("PUT", "/store/customers/me/addresses/addr-1", () => ({ status: 204 }));
    await updateAddress("addr-1", { line1: "2 Test Street", city: "Lagos", isDefault: false });
    expect(testServer.last()?.method).toBe("PUT");
    expect(testServer.last()?.path).toBe("/store/customers/me/addresses/addr-1");

    testServer.when("DELETE", "/store/customers/me/addresses/addr-1", () => ({ status: 204 }));
    await deleteAddress("addr-1");
    expect(testServer.last()?.method).toBe("DELETE");
    expect(testServer.last()?.path).toBe("/store/customers/me/addresses/addr-1");
  });

  it("parses customer profile shape used by the account view", async () => {
    await testServer.listen();
    testServer.clearReceived();
    testServer.when("GET", "/store/customers/me", () => ({
      status: 200,
      body: makeCustomer({ id: CUSTOMER_ID }),
    }));
    const customer = await (await import("../../src/lib/api/customers")).getMe();
    expect(customer.id).toBe(CUSTOMER_ID);
  });
});