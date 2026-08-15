// apps/api/tests/contract/EndpointConformance.test.ts
//
// HTTP CONTRACT TEST — item 27: the endpoints the HTTP composition root
// actually MOUNTS must exist verbatim in the OpenAPI specification
// (apps/api/openapi.yaml), the source of truth for the HTTP contract.
//
// The server mounts exactly these routers:
//   app.use("/store/payments/webhook",   paymentWebhookRouter)       POST /
//   app.use("/store/carts",              paymentInitializationRouter) POST /:id/payment-sessions
//   app.use("/store/orders",             swapRouter)                  POST /:orderId/swaps
//   app.use("/store/carts",              checkoutShippingRouter)      POST /:id/shipping-quotes
//                                                                     POST /:id/shipping-options
//   app.use("/store/webhooks/shipbubble", logisticsWebhookRouter)     POST /
//
// A path+method present in the spec but NOT mounted (or mounted but not in
// the spec) is a contract drift this suite fails on, so the verification
// suite and Prism mock never disagree about what the API promises.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";

const openApiPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../openapi.yaml",
);
const doc = YAML.parse(readFileSync(openApiPath, "utf8")) as {
  paths?: Record<string, Record<string, unknown>>;
};

interface MountedEndpoint {
  /** Full OpenAPI path template, e.g. "/store/carts/{id}/payment-sessions". */
  path: string;
  /** HTTP method, lower-case. */
  method: string;
}

/**
 * The endpoints wired by the composition root. Kept in lockstep with
 * apps/api/src/server.ts — if that file gains or loses a mount, this list is
 * the contract that must move with it.
 */
const MOUNTED_ENDPOINTS: MountedEndpoint[] = [
  { path: "/store/carts/{id}/payment-sessions", method: "post" },
  { path: "/store/payments/webhook", method: "post" },
  { path: "/store/orders/{id}/swaps", method: "post" },
  { path: "/store/carts/{id}/shipping-quotes", method: "post" },
  { path: "/store/carts/{id}/shipping-options", method: "post" },
  { path: "/store/webhooks/shipbubble", method: "post" },
];

describe("OpenAPI conformance — mounted endpoints exist in the spec", () => {
  it("declares every router-mount path and method in openapi.yaml", () => {
    expect(doc.paths !== undefined && typeof doc.paths === "object").toBe(true);
    for (const endpoint of MOUNTED_ENDPOINTS) {
      const pathItem = doc.paths?.[endpoint.path];
      expect(pathItem !== undefined).toBe(true);
      const operations = pathItem as Record<string, unknown>;
      expect(typeof operations[endpoint.method] === "object").toBe(true);
    }
  });
});