// apps/api/tests/contract/catalog/CatalogRouter.test.ts
//
// HTTP CONTRACT TESTS — storefront catalogue endpoints.
//
// The transport boundary must:
//   - pass query params / context headers through to the use cases (limits,
//     filters, expand/fields, includeDescendants) WITHOUT imposing business
//     rules of its own.
//   - reject malformed query params (non-integer limits, non-boolean
//     includeDescendants) with 400 VALIDATION_ERROR.
//   - require a valid bearer token on POST /products/:id/reviews and derive
//     the customerId from the token ONLY (a client-supplied customerId is
//     rejected with 400).
//   - map PRODUCT_NOT_FOUND -> 404 and UNAUTHORIZED_REVIEW -> 403.
//   - NOT register routes whose use case is unwired (requests 404).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import express, { Express } from "express";
import type { AddressInfo } from "node:net";
import { createCatalogRouter } from "@api/adapters/http/routers/CatalogRouter";
import {
  createNotFoundHandler,
  createTerminalErrorHandler,
} from "@api/adapters/http/errors";
import { FakeTokenService } from "../../fakes/FakeTokenService";
import { NoopLogger } from "../../fakes/NoopLogger";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { Product } from "@api/domain/entities/Product";
import type { ProductVariant } from "@api/domain/entities/ProductVariant";
import type { Category } from "@api/domain/entities/Category";

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

async function requestJson(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  options: { query?: string; headers?: Record<string, string>; body?: unknown; bearer?: string } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (options.headers) {
    Object.assign(headers, options.headers);
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.bearer) {
    headers.authorization = `Bearer ${options.bearer}`;
  }
  const response = await fetch(`${baseUrl}${path}${options.query ?? ""}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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

const SAMPLE_VARIANT = {
  id: "variant-1",
  productId: "product-1",
  sku: "TEE-S-M",
  inventoryQuantity: 12,
  allowBackorder: false,
  version: 3,
} as unknown as ProductVariant;

const SAMPLE_PRODUCT = {
  id: "product-1",
  title: "Classic Tee",
  handle: "classic-tee",
  description: null,
  variants: [SAMPLE_VARIANT],
} as unknown as Product;

const SAMPLE_CATEGORY = {
  id: "cat-1",
  name: "Tops",
  parentCategoryId: null,
  createdAt: new Date().toISOString(),
} as unknown as Category;

interface CatalogCalls {
  browse: Array<Record<string, unknown>>;
  details: Array<Record<string, unknown>>;
  search: Array<Record<string, unknown>>;
  related: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  availability: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
}

interface CatalogHarness {
  calls: CatalogCalls;
  /** Build the router with every optional use case wired (default). */
  build: (withOptional?: boolean) => Express;
}

function buildHarness(options?: {
  productNotFound?: boolean;
  unauthorizedReview?: boolean;
}): CatalogHarness {
  const calls: CatalogCalls = {
    browse: [],
    details: [],
    search: [],
    related: [],
    reviews: [],
    availability: [],
    categories: [],
  };
  const tokenService = new FakeTokenService(new Map([["valid-token", VALID_CLAIMS]]));
  const logger = new NoopLogger();

  const build = (withOptional = true): Express => {
    const app = express();
    app.use(
      "/store",
      createCatalogRouter({
        browseCatalog: {
          async execute(input: Record<string, unknown>) {
            calls.browse.push({ ...input });
            return { items: [SAMPLE_PRODUCT], total: 1 };
          },
        } as never,
        getProductDetails: {
          async execute(input: Record<string, unknown>) {
            calls.details.push({ ...input });
            if (options?.productNotFound) {
              throw new DomainError("PRODUCT_NOT_FOUND", "Product not found.");
            }
            return SAMPLE_PRODUCT;
          },
        } as never,
        retrieveCategoryTree: {
          async execute(input: Record<string, unknown>) {
            calls.categories.push({ ...input });
            return [SAMPLE_CATEGORY];
          },
        } as never,
        submitProductReview: {
          async execute(input: Record<string, unknown>) {
            calls.reviews.push({ ...input });
            if (options?.unauthorizedReview) {
              throw new DomainError(
                "UNAUTHORIZED_REVIEW",
                "You must purchase this product before submitting a review.",
              );
            }
          },
        } as never,
        searchProducts: withOptional
          ? ({
              async execute(input: Record<string, unknown>) {
                calls.search.push({ ...input });
                return [SAMPLE_PRODUCT];
              },
            } as never)
          : undefined,
        resolveCrossSellingProducts: withOptional
          ? ({
              async execute(input: Record<string, unknown>) {
                calls.related.push({ ...input });
                return [SAMPLE_PRODUCT];
              },
            } as never)
          : undefined,
        getVariantAvailability: withOptional
          ? ({
              async execute(input: Record<string, unknown>) {
                calls.availability.push({ ...input });
                return {
                  variantId: "variant-1",
                  inventoryQuantity: 5,
                  allowBackorder: false,
                  priceMinor: 2500,
                };
              },
            } as never)
          : undefined,
        tokenService,
        logger,
      }),
    );
    // Mirror the real server composition (server.ts): unmatched paths become
    // the canonical JSON 404 instead of Express's default HTML page.
    app.use(createNotFoundHandler(new NoopLogger()));
    app.use(createTerminalErrorHandler(new NoopLogger()));
    return app;
  };

  return { calls, build };
}

describe("GET /store/products — catalogue browse", () => {
  it("200 passes context headers + defaults to the use case", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products", {
        headers: { sales_channel_id: "sc-1", region_id: "rg-1" },
      });
      expect(response.status).toBe(200);
      expect((response.body as { total?: number }).total).toBe(1);
      const call = harness.calls.browse[0];
      expect(call.salesChannelId).toBe("sc-1");
      expect(call.regionId).toBe("rg-1");
      expect(call.limit).toBe(20);
      expect(call.offset).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("200 passes explicit limit/offset/category/search query params", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products", {
        query: "?limit=5&offset=10&categoryId=cat-1&searchQuery=tee",
      });
      expect(response.status).toBe(200);
      const call = harness.calls.browse[0];
      expect(call.limit).toBe(5);
      expect(call.offset).toBe(10);
      expect(call.categoryId).toBe("cat-1");
      expect(call.searchQuery).toBe("tee");
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a non-integer limit", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products", {
        query: "?limit=abc",
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "limit must be an integer." },
      });
      expect(harness.calls.browse).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for an out-of-range limit", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products", {
        query: "?limit=100000",
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "limit must be between 1 and 200." },
      });
    } finally {
      await server.close();
    }
  });
});

describe("GET /store/products/:id — product details", () => {
  it("200 returns the product projection", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products/product-1", {
        headers: { sales_channel_id: "sc-1", region_id: "rg-1" },
      });
      expect(response.status).toBe(200);
      expect((response.body as { id?: string }).id).toBe("product-1");
      expect(harness.calls.details[0].productId).toBe("product-1");
    } finally {
      await server.close();
    }
  });

  it("200 parses expand/fields CSV into arrays", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products/product-1", {
        query: "?expand=variants,variants.options&fields=id,title",
      });
      expect(response.status).toBe(200);
      expect(harness.calls.details[0].expand).toEqual(["variants", "variants.options"]);
      expect(harness.calls.details[0].fields).toEqual(["id", "title"]);
    } finally {
      await server.close();
    }
  });

  it("404 PRODUCT_NOT_FOUND when the product is not visible", async () => {
    const harness = buildHarness({ productNotFound: true });
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products/ghost", {
        headers: { sales_channel_id: "sc-1", region_id: "rg-1" },
      });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        success: false,
        error: { code: "PRODUCT_NOT_FOUND", message: "Product not found." },
      });
    } finally {
      await server.close();
    }
  });
});

describe("catalogue public projections — no internal state leaks", () => {
  it("GET /store/products/:id exposes ONLY the OpenAPI Product contract fields", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products/product-1");
      expect(response.status).toBe(200);
      const product = response.body;
      expect(product).toEqual({
        id: "product-1",
        title: "Classic Tee",
        handle: "classic-tee",
        description: null,
        variants: [
          {
            id: "variant-1",
            productId: "product-1",
            sku: "TEE-S-M",
            inventoryQuantity: 12,
            allowBackorder: false,
            version: 3,
          },
        ],
      });
      // Never a leaked internal key: underscore-backed entity state, category /
      // sales-channel membership, inventory or pricing metadata.
      for (const key of [
        "_title",
        "_handle",
        "_variants",
        "_categoryIds",
        "_salesChannelIds",
        "categoryIds",
        "salesChannelIds",
      ]) {
        expect(key in product).toBe(false);
      }
    } finally {
      await server.close();
    }
  });

  it("GET /store/products items are public Product projections, never entities", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products");
      expect(response.status).toBe(200);
      const items = (response.body as { items: Record<string, unknown>[] }).items;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("product-1");
      expect(items[0].title).toBe("Classic Tee");
      expect(items[0].handle).toBe("classic-tee");
      for (const key of ["_title", "_handle", "_variants", "categoryIds", "salesChannelIds"]) {
        expect(key in items[0]).toBe(false);
      }
    } finally {
      await server.close();
    }
  });
});

describe("GET /store/products/search — full-text search", () => {
  it("200 returns matching products when a search service is wired", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products/search", {
        query: "?query=tee",
      });
      expect(response.status).toBe(200);
      expect(harness.calls.search).toHaveLength(1);
      expect(harness.calls.search[0].query).toBe("tee");
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR when the query param is missing", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products/search");
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "query is required." },
      });
    } finally {
      await server.close();
    }
  });

  it("404 when no search service is configured (route not registered)", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build(false));
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products/search", {
        query: "?query=tee",
      });
      expect(response.status).toBe(404);
      expect(harness.calls.search).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("GET /store/products/:id/related — recommendations", () => {
  it("200 returns recommendations when a recommendation engine is wired", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products/product-1/related", {
        query: "?limit=2",
        headers: { sales_channel_id: "sc-1", region_id: "rg-1" },
      });
      expect(response.status).toBe(200);
      expect(harness.calls.related).toHaveLength(1);
      expect(harness.calls.related[0].limit).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("404 when no recommendation engine is configured", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build(false));
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/products/product-1/related");
      expect(response.status).toBe(404);
      expect(harness.calls.related).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("POST /store/products/:id/reviews — verified-buyer reviews", () => {
  it("201 submits a review with the token-derived customerId", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "POST", "/store/products/product-1/reviews", {
        body: { rating: 5, comment: "Great fit." },
        bearer: "valid-token",
      });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ success: true });
      expect(harness.calls.reviews).toHaveLength(1);
      expect(harness.calls.reviews[0].customerId).toBe("customer-1");
      expect(harness.calls.reviews[0].rating).toBe(5);
      expect(harness.calls.reviews[0].productId).toBe("product-1");
    } finally {
      await server.close();
    }
  });

  it("401 UNAUTHORIZED_ACCESS without a bearer token", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "POST", "/store/products/product-1/reviews", {
        body: { rating: 5 },
      });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: { code: "UNAUTHORIZED_ACCESS", message: "Authentication required." },
      });
      expect(harness.calls.reviews).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a client-supplied customerId", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "POST", "/store/products/product-1/reviews", {
        body: { rating: 5, customerId: "customer-999" },
        bearer: "valid-token",
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: 'Unexpected field "customerId" in request body.',
        },
      });
      expect(harness.calls.reviews).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a missing rating", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "POST", "/store/products/product-1/reviews", {
        body: { comment: "No rating." },
        bearer: "valid-token",
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "rating is required." },
      });
      expect(harness.calls.reviews).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("403 UNAUTHORIZED_REVIEW for a non-verified buyer", async () => {
    const harness = buildHarness({ unauthorizedReview: true });
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "POST", "/store/products/product-1/reviews", {
        body: { rating: 5 },
        bearer: "valid-token",
      });
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "UNAUTHORIZED_REVIEW",
          message: "You must purchase this product before submitting a review.",
        },
      });
    } finally {
      await server.close();
    }
  });
});

describe("GET /store/variants/:id/availability — availability + regional price", () => {
  it("200 returns the availability DTO when a pricing service is wired", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/variants/variant-1/availability", {
        headers: { region_id: "rg-1" },
      });
      expect(response.status).toBe(200);
      expect((response.body as { variantId?: string }).variantId).toBe("variant-1");
      expect(harness.calls.availability[0].regionId).toBe("rg-1");
    } finally {
      await server.close();
    }
  });

  it("404 when no pricing service is configured", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build(false));
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/variants/variant-1/availability");
      expect(response.status).toBe(404);
      expect(harness.calls.availability).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("GET /store/product-categories — category tree", () => {
  it("200 defaults includeDescendants to true", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/product-categories");
      expect(response.status).toBe(200);
      expect(harness.calls.categories[0].includeDescendants).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("200 passes includeDescendants=false", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/product-categories", {
        query: "?includeDescendants=false",
      });
      expect(response.status).toBe(200);
      expect(harness.calls.categories[0].includeDescendants).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("400 VALIDATION_ERROR for a non-boolean includeDescendants", async () => {
    const harness = buildHarness();
    const server = await startServer(harness.build());
    try {
      const response = await requestJson(server.baseUrl, "GET", "/store/product-categories", {
        query: "?includeDescendants=maybe",
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: 'includeDescendants must be a boolean ("true" or "false").',
        },
      });
    } finally {
      await server.close();
    }
  });
});
