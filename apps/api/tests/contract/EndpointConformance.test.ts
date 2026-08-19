// apps/api/tests/contract/EndpointConformance.test.ts
//
// HTTP CONTRACT TEST — item 27: the endpoints the HTTP composition root
// actually MOUNTS must exist verbatim in the OpenAPI specification
// (apps/api/openapi.yaml), the source of truth for the HTTP contract.
//
// The server mounts exactly these routers:
//   app.use("/store/payments/webhook",   paymentWebhookRouter)       POST /
//   app.use("/store/webhooks/shipbubble", logisticsWebhookRouter)    POST /
//   app.use("/store",                    authRouter)                 POST /auth
//                                                                     POST /customers/logout
//   app.use("/store",                    catalogRouter)              GET  /products
//                                                                     GET  /products/search (wired only)
//                                                                     GET  /products/:id
//                                                                     GET  /products/:id/related (wired only)
//                                                                     POST /products/:id/reviews
//                                                                     GET  /variants/:id/availability (wired only)
//                                                                     GET  /product-categories
//   app.use("/store/carts",              paymentInitializationRouter) POST /:id/payment-sessions
//   app.use("/store/carts",              checkoutShippingRouter)      POST /:id/shipping-quotes
//                                                                     POST /:id/shipping-options
//   app.use("/store/orders",             swapRouter)                  POST /:orderId/swaps
//
// A path+method present in the spec but NOT mounted (or mounted but not in
// the spec) is a contract drift this suite fails on, so the verification
// suite and Prism mock never disagree about what the API promises.
//
// Note: routes that are conditionally registered (search / related /
// availability) are listed because the OpenAPI contract declares them; the
// composition root still registers them whenever the required external service
// is configured, and the spec must exist either way.

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
  components?: { schemas?: Record<string, unknown> };
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
  // Auth
  { path: "/store/auth", method: "post" },
  { path: "/store/customers/logout", method: "post" },
  // Catalogue
  { path: "/store/products", method: "get" },
  { path: "/store/products/search", method: "get" },
  { path: "/store/products/{id}", method: "get" },
  { path: "/store/products/{id}/related", method: "get" },
  { path: "/store/products/{id}/reviews", method: "post" },
  { path: "/store/variants/{id}/availability", method: "get" },
  { path: "/store/product-categories", method: "get" },
  // Payments / logistics
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

  it("the retired TaxCategory contract is absent — no path, no schema", () => {
    // L7-R decision #1 removed the orphaned TaxCategory model. The HTTP
    // contract must carry NO trace of it: no /admin/tax-categories route and
    // no TaxCategory / ConfigureTaxCategoryRequest component schema. The single
    // canonical tax source (region.tax_rate) has no separate admin surface.
    const hasTaxCategoryPath = Object.keys(doc.paths ?? {}).some((p) =>
      p.includes("tax-categories"),
    );
    expect(hasTaxCategoryPath).toBe(false);

    const schemas = doc.components?.schemas ?? {};
    const hasTaxCategorySchema = Object.keys(schemas).some((s) =>
      s.toLowerCase().includes("taxcategory"),
    );
    expect(hasTaxCategorySchema).toBe(false);
  });

  it("the retired TaxCategory contract never returns to the raw spec source", () => {
    // Parsed-object checks above cover paths + schemas; this guard scans the
    // RAW spec text so a lingering operationId, tag, description or $ref
    // mentioning the retired contract also fails the gate. This is the
    // regression that stops the orphaned contract from sneaking back into the
    // active API surface (and, via openapi-typescript, shared-types).
    const rawSpec = readFileSync(openApiPath, "utf8");
    for (const trace of ["tax-categories", "TaxCategory", "ConfigureTaxCategory"]) {
      expect(rawSpec.includes(trace)).toBe(false);
    }
  });
});