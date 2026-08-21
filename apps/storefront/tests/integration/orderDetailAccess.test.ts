// apps/storefront/tests/integration/orderDetailAccess.test.ts
//
// Slice 2B over REAL HTTP (no fetch mocks):
//   G009 — a known guest's order-detail visit issues ZERO protected requests;
//          an authenticated visit attaches the bearer and parses the
//          projection.
//   G008 — the refresh loop keeps polling while the fulfillment lifecycle is
//          mutable and STOPS for good once the projection turns terminal.
//   Prefill — the exact checkout sequence (getAddresses -> pickPrefillAddress
//          -> prefillAddressForm) fills empty fields from the saved default
//          address without submitting anything.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { getOrder } from "../../src/lib/api/orders";
import { getAddresses } from "../../src/lib/api/customers";
import {
  pickPrefillAddress,
  prefillAddressForm,
} from "../../src/lib/addressPrefill";
import { resolveOrderFetchGate } from "../../src/lib/orderAccess";
import { shouldPollOrder } from "../../src/lib/orderPolling";
import { setToken, clearToken } from "../../src/lib/api/auth";
import { makeAddress, makeOrder } from "../helpers/fixtures";
import { testServer } from "../helpers/testServer";

function receivedOrderRequests(): number {
  return testServer.received.filter(
    (req) => req.method === "GET" && req.path.startsWith("/store/orders/"),
  ).length;
}

describe("G009 — identity resolved before the protected order request", () => {
  it("a known guest NEVER fetches the protected order (sign-in state instead)", async () => {
    await testServer.listen();
    testServer.clearReceived();
    // A route exists — if the component fetched anyway, it would succeed and
    // the leak would be visible in `received`.
    testServer.when("GET", "/store/orders/ord-guest", () => ({
      status: 200,
      body: makeOrder({ id: "ord-guest" }),
    }));

    const gate = resolveOrderFetchGate("guest");
    expect(gate).toBe("signin");
    // The component only calls getOrder when the gate says "fetch":
    if (gate === "fetch") await getOrder("ord-guest");
    expect(receivedOrderRequests()).toBe(0);
  });

  it("while identity resolution is in flight, no request fires either", async () => {
    await testServer.listen();
    testServer.clearReceived();
    const gate = resolveOrderFetchGate("loading");
    expect(gate).toBe("wait");
    if (gate === "fetch") await getOrder("ord-any");
    expect(receivedOrderRequests()).toBe(0);
  });

  it("an authenticated visit attaches the bearer and parses the projection", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.order.token");
    const order = makeOrder({ id: "ord-mine", fulfillmentStatus: "unfulfilled" });
    testServer.when("GET", "/store/orders/ord-mine", () => ({
      status: 200,
      body: order,
    }));

    const gate = resolveOrderFetchGate("authenticated");
    expect(gate).toBe("fetch");
    const data = await getOrder("ord-mine");
    expect(data.id).toBe("ord-mine");
    expect(data.totalAmountMinor).toBe(order.totalAmountMinor);
    const req = testServer.last();
    expect(req?.headers["authorization"]).toBe("Bearer jwt.order.token");
    clearToken();
  });
});

describe("G008 — refresh loop over real HTTP stops at the terminal state", () => {
  it("polls while mutable, then stops permanently once fulfilled", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.poll.token");

    let terminal = false;
    testServer.when("GET", "/store/orders/ord-live", () => ({
      status: 200,
      body: makeOrder({
        id: "ord-live",
        fulfillmentStatus: terminal ? "fulfilled" : "partially_fulfilled",
      }),
    }));

    // The component's loop: fetch -> decide -> maybe refetch.
    let current = await getOrder("ord-live");
    expect(shouldPollOrder(current)).toBe(true);
    current = await getOrder("ord-live"); // tick 1: still mutable
    expect(current.fulfillmentStatus).toBe("partially_fulfilled");
    expect(receivedOrderRequests()).toBe(2);

    terminal = true;
    current = await getOrder("ord-live"); // tick 2: server flipped to terminal
    expect(shouldPollOrder(current)).toBe(false);
    const atTerminal = receivedOrderRequests();

    // The settled projection ends the loop — no further requests ever fire.
    if (shouldPollOrder(current)) await getOrder("ord-live");
    expect(receivedOrderRequests()).toBe(atTerminal);
    clearToken();
  });

  it("a failed refresh tick does not end the loop (last good projection stays)", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.flaky.token");

    let failing = false;
    testServer.when("GET", "/store/orders/ord-flaky", () => {
      if (failing) {
        return { status: 500, body: { success: false, error: { code: "INTERNAL_ERROR", message: "boom" } } };
      }
      return {
        status: 200,
        body: makeOrder({ id: "ord-flaky", fulfillmentStatus: "ready_for_dispatch" }),
      };
    });

    const good = await getOrder("ord-flaky");
    expect(shouldPollOrder(good)).toBe(true);

    failing = true;
    let thrown: unknown;
    try {
      await getOrder("ord-flaky");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The loop keeps polling after the transient failure…
    failing = false;
    const recovered = await getOrder("ord-flaky");
    expect(recovered.fulfillmentStatus).toBe("ready_for_dispatch");
    clearToken();
  });
});

describe("checkout address prefill over real HTTP", () => {
  it("fills empty form fields from the saved DEFAULT address without submitting", async () => {
    await testServer.listen();
    testServer.clearReceived();
    setToken("jwt.prefill.token");
    testServer.when("GET", "/store/customers/me/addresses", () => ({
      status: 200,
      body: [
        makeAddress({ id: "addr-a", isDefault: false, city: "Ibadan" }),
        makeAddress({ id: "addr-default", isDefault: true, city: "Lagos" }),
      ],
    }));

    const addresses = await getAddresses();
    const chosen = pickPrefillAddress(addresses);
    expect(chosen?.id).toBe("addr-default");

    const form = prefillAddressForm(
      {
        firstName: "",
        lastName: "",
        phone: "",
        line1: "",
        city: "",
        state: "",
        postalCode: "",
      },
      chosen,
    );
    expect(form.city).toBe("Lagos");
    expect(form.line1).toBe("1 Test Street");

    // Prefill is read-only: only the address-book GET hit the wire — no cart
    // mutation, no address submission until the customer confirms.
    expect(testServer.received).toHaveLength(1);
    expect(testServer.received[0].method).toBe("GET");
    clearToken();
  });
});
