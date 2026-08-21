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
//   app.use("/store/webhooks/courier-tracking", courierTrackingWebhookRouter) POST /
//   app.use("/store",                    customersRouter)            POST /customers
//                                                                     GET  /customers/me
//                                                                     GET  /customers/me/addresses
//                                                                     POST /customers/password-reset/initiate
//                                                                     POST /customers/password-reset/complete
//                                                                     POST /customers/me/addresses
//                                                                     PUT/DELETE /customers/me/addresses/:address_id
//                                                                     POST /customers/me/business-units
//                                                                     POST /customers/me/quotes
//                                                                     POST /quotes/:id/approve
//                                                                     GET  /customers/me/orders
//                                                                     POST /customers/me/erasure
//   app.use("/store",                    ordersRouter)               GET  /orders/:orderId
//                                                                     POST /orders/:orderId/returns
//                                                                     POST /orders/:orderId/edits
//                                                                     POST /order-edits/:orderEditId/confirm
//                                                                     POST /orders/:orderId/fulfillments
//   app.use("/store/carts",              cartRouter)                 GET  /:id
//                                                                     POST /
//                                                                     POST /:id/line-items
//                                                                     POST /:id/line-items/custom
//                                                                     PUT /:id/line-items/:line_id
//                                                                     DELETE /:id/line-items/:line_id
//                                                                     POST /:id/discount
//                                                                     POST /:id/merge
//                                                                     PUT /:id/shipping-address
//   app.use("/admin",                    adminRouter)                POST /products
//                                                                     POST /products/:id/variants
//                                                                     POST /variants/:id/regional-prices
//                                                                     POST /promotions
//                                                                     POST /sales-channels
//                                                                     POST /categories
//                                                                     PUT /roles/:id/permissions
//                                                                     POST /imports/bulk-catalog
//                                                                     GET  /queues/:queue_name/dead-letter
//                                                                     POST /queues/:queue_name/dead-letter/:job_id/retry
//                                                                     POST /draft-orders
//                                                                     POST /sourcing-location
//                                                                     POST /carts/prune
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
  // Carts (F3)
  { path: "/store/carts", method: "post" },
  { path: "/store/carts/{id}", method: "get" },
  { path: "/store/carts/{id}/line-items", method: "post" },
  { path: "/store/carts/{id}/line-items/custom", method: "post" },
  { path: "/store/carts/{id}/line-items/{line_id}", method: "put" },
  { path: "/store/carts/{id}/line-items/{line_id}", method: "delete" },
  { path: "/store/carts/{id}/discount", method: "post" },
  { path: "/store/carts/{id}/merge", method: "post" },
  { path: "/store/carts/{id}/shipping-address", method: "put" },
  // Customers (F3)
  { path: "/store/customers", method: "post" },
  { path: "/store/customers/me", method: "get" },
  { path: "/store/customers/me/addresses", method: "get" },
  { path: "/store/customers/password-reset/initiate", method: "post" },
  { path: "/store/customers/password-reset/complete", method: "post" },
  { path: "/store/customers/me/addresses", method: "post" },
  { path: "/store/customers/me/addresses/{address_id}", method: "put" },
  { path: "/store/customers/me/addresses/{address_id}", method: "delete" },
  { path: "/store/customers/me/business-units", method: "post" },
  { path: "/store/customers/me/quotes", method: "post" },
  { path: "/store/quotes/{id}/approve", method: "post" },
  { path: "/store/customers/me/orders", method: "get" },
  { path: "/store/customers/me/erasure", method: "post" },
  // Orders / logistics (F3)
  { path: "/store/orders/{id}", method: "get" },
  { path: "/store/orders/{id}/returns", method: "post" },
  { path: "/store/orders/{id}/edits", method: "post" },
  { path: "/store/order-edits/{id}/confirm", method: "post" },
  { path: "/store/orders/{id}/fulfillments", method: "post" },
  { path: "/store/webhooks/courier-tracking", method: "post" },
  // Admin (F3)
  { path: "/admin/products", method: "post" },
  { path: "/admin/products/{id}/variants", method: "post" },
  { path: "/admin/variants/{id}/regional-prices", method: "post" },
  { path: "/admin/promotions", method: "post" },
  { path: "/admin/sales-channels", method: "post" },
  { path: "/admin/categories", method: "post" },
  { path: "/admin/roles/{id}/permissions", method: "put" },
  { path: "/admin/imports/bulk-catalog", method: "post" },
  { path: "/admin/queues/{queue_name}/dead-letter", method: "get" },
  { path: "/admin/queues/{queue_name}/dead-letter/{job_id}/retry", method: "post" },
  { path: "/admin/draft-orders", method: "post" },
  { path: "/admin/sourcing-location", method: "post" },
  { path: "/admin/carts/prune", method: "post" },
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

  it("declares EVERY operation in the spec — mounted OR an explicit documented gap", () => {
    // Reverse direction of the mount->spec check: every path+method the spec
    // declares must be EITHER mounted by the composition root (in
    // MOUNTED_ENDPOINTS) OR listed here as an intentionally-unmounted
    // operation. An operation that is neither mounted nor documented as a gap
    // is contract drift the verification suite must fail on, so the spec and
    // the server can never silently disagree about what the API promises.
    //
    // The gap list mirrors the reconciliation matrix §3/§4: the C-blocked
    // (missing infrastructure) operations have NO router or an explicitly
    // unregistered route, and the catalog search/related/availability operations
    // are registered only when their capability is wired. Each entry names the
    // reason so the failure message stays actionable.
    const UNMOUNTED_BY_DESIGN: Array<{ path: string; method: string }> = [
      // C — blocked on missing infrastructure (no adapter in the repository).
      { path: "/store/carts/{id}/insurance-quote", method: "post" },
      { path: "/admin/variants/{id}/inventory", method: "post" },
      { path: "/admin/maintenance/stale-transactions", method: "post" },
    ];

    const mountedSet = new Set(
      MOUNTED_ENDPOINTS.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    );
    const gapSet = new Set(
      UNMOUNTED_BY_DESIGN.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    );

    expect(doc.paths !== undefined && typeof doc.paths === "object").toBe(true);
    const declared: Array<{ path: string; method: string }> = [];
    for (const [path, pathItem] of Object.entries(
      doc.paths as Record<string, Record<string, unknown>>,
    )) {
      for (const method of Object.keys(pathItem)) {
        if (["parameters", "summary", "description"].includes(method)) {
          continue;
        }
        declared.push({ path, method });
      }
    }

    // Every declared operation is accounted for: mounted, or a documented gap.
    for (const endpoint of declared) {
      const key = `${endpoint.method} ${endpoint.path}`;
      const ok = mountedSet.has(key) || gapSet.has(key);
      expect(ok).toBe(true);
    }

    // Every gap is genuinely declared by the spec (no stale gap entries).
    for (const gap of UNMOUNTED_BY_DESIGN) {
      const pathItem = doc.paths?.[gap.path] as
        | Record<string, unknown>
        | undefined;
      expect(pathItem !== undefined).toBe(true);
      expect(typeof pathItem?.[gap.method] === "object").toBe(true);
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