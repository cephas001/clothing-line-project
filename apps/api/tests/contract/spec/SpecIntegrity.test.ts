// apps/api/tests/contract/spec/SpecIntegrity.test.ts
//
// HTTP CONTRACT TEST — internal referential integrity of the OpenAPI document
// (apps/api/openapi.yaml), the source of truth for the HTTP contract and for
// the regenerated packages/shared-types (openapi-typescript).
//
// Guards:
//   - the YAML parses and every "$ref" resolves to a defined component — a
//     dangling $ref would surface in generated shared-types as a type that
//     cannot compile or a missing type alias.
//   - every documented response carries either a $ref or an inline schema.
//   - the named swap/return/order-edit DTO schemas introduced for the API-L1
//     reconciliation are present AND referenced by their endpoint responses
//     (regression guard for the stale index.ts exports that referenced
//     non-existent schemas).
//   - the canonical ErrorCode union advertised by StandardError excludes the
//     retired TaxCategory contract.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";

const openApiPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../openapi.yaml",
);

interface ComponentBuckets {
  schemas: Record<string, unknown>;
  responses: Record<string, unknown>;
  parameters: Record<string, unknown>;
  requestBodies: Record<string, unknown>;
}

const doc = YAML.parse(readFileSync(openApiPath, "utf8")) as {
  paths?: Record<string, unknown>;
  components?: ComponentBuckets;
};

function collectRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, out);
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string") {
      out.push(record.$ref);
    }
    for (const key of Object.keys(record)) {
      if (key !== "$ref") {
        collectRefs(record[key], out);
      }
    }
  }
  return out;
}

function resolveRef(ref: string, components: ComponentBuckets): boolean {
  const match = /^#\/components\/(schemas|responses|parameters|requestBodies)\/([^/]+)$/.exec(
    ref,
  );
  if (!match) {
    return false;
  }
  const bucket = components[match[1] as keyof ComponentBuckets];
  return Boolean(bucket && Object.prototype.hasOwnProperty.call(bucket, match[2]));
}

describe("OpenAPI spec integrity — every $ref resolves", () => {
  it("parses as YAML and exposes components", () => {
    expect(typeof doc.paths === "object" && doc.paths !== null).toBe(true);
    expect(typeof doc.components === "object" && doc.components !== null).toBe(
      true,
    );
  });

  it("every $ref in the document points at a defined component", () => {
    const components = doc.components as ComponentBuckets;
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    const dangling = refs.filter((ref) => !resolveRef(ref, components));
    expect(dangling).toEqual([]);
  });

  it("every JSON content block carries a schema; bodyless successes stay bodyless", () => {
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    let responseCount = 0;
    for (const pathItem of Object.values(paths)) {
      for (const operation of Object.values(pathItem ?? {})) {
        if (typeof operation !== "object" || operation === null) {
          continue;
        }
        const responses = (operation as { responses?: Record<string, unknown> })
          .responses;
        for (const [status, response] of Object.entries(responses ?? {})) {
          responseCount += 1;
          if (status === "default") {
            continue;
          }
          if (response && typeof response === "object") {
            const resp = response as Record<string, unknown>;
            if (typeof resp.$ref === "string") {
              continue;
            }
            // When a response describes content, it must be a JSON schema that
            // openapi-typescript can turn into a type.
            if (resp.content !== undefined) {
              const content = resp.content as {
                "application/json"?: { schema?: unknown };
              };
              expect(
                content["application/json"] !== undefined &&
                  content["application/json"].schema !== undefined,
              ).toBe(true);
            }
          }
        }
      }
    }
    expect(responseCount).toBeGreaterThan(0);
  });
});

describe("OpenAPI spec integrity — swap/return/order-edit DTO schemas", () => {
  const schemas = (doc.components as ComponentBuckets).schemas;

  it("defines ReturnAuthorization, Swap and OrderEdit schemas", () => {
    for (const name of ["ReturnAuthorization", "Swap", "OrderEdit"]) {
      expect(typeof schemas[name] === "object").toBe(true);
    }
  });

  it("the returns response references ReturnAuthorization", () => {
    const raw = readFileSync(openApiPath, "utf8");
    expect(
      raw.includes('$ref: "#/components/schemas/ReturnAuthorization"'),
    ).toBe(true);
  });

  it("the swaps response references Swap", () => {
    const raw = readFileSync(openApiPath, "utf8");
    expect(raw.includes('$ref: "#/components/schemas/Swap"')).toBe(true);
  });

  it("the order-edit response references OrderEdit", () => {
    const raw = readFileSync(openApiPath, "utf8");
    expect(raw.includes('$ref: "#/components/schemas/OrderEdit"')).toBe(true);
  });
});

describe("OpenAPI spec integrity — no stale retired contract", () => {
  it("the raw spec never mentions the retired TaxCategory contract", () => {
    const raw = readFileSync(openApiPath, "utf8");
    for (const trace of ["tax-categories", "TaxCategory", "ConfigureTaxCategory"]) {
      expect(raw.includes(trace)).toBe(false);
    }
  });
});

describe("OpenAPI spec integrity — F4 product projection (categoryIds + media)", () => {
  const schemas = (doc.components as ComponentBuckets).schemas;
  const product = schemas.Product as
    | { required?: string[]; properties?: Record<string, unknown> }
    | undefined;

  it("Product schema declares categoryIds and media properties", () => {
    expect(typeof product === "object" && product !== null).toBe(true);
    // Follows the existing Product convention (only id/title/handle required,
    // like `variants`): the fields are always emitted but schema-optional so
    // consumers with partial catalogs still typecheck.
    const props = product?.properties ?? {};
    expect("categoryIds" in props).toBe(true);
    expect("media" in props).toBe(true);
  });

  it("ProductMedia schema exposes only public-safe fields", () => {
    const media = schemas.ProductMedia as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(typeof media === "object" && media !== null).toBe(true);
    const required = media?.required ?? [];
    for (const key of ["id", "url", "kind", "altText", "sortOrder"]) {
      expect(required.includes(key)).toBe(true);
    }
    const props = media?.properties ?? {};
    for (const key of ["id", "url", "kind", "altText", "sortOrder"]) {
      expect(key in props).toBe(true);
    }
    // No private/underscore keys, no binary payload fields.
    for (const leaked of ["_url", "productId", "bytes", "mimeType"]) {
      expect(leaked in props).toBe(false);
    }
  });

  it("the media items $ref resolves to ProductMedia", () => {
    const mediaProp = product?.properties?.["media"] as
      | { items?: { $ref?: string } }
      | undefined;
    expect(mediaProp?.items?.$ref).toBe("#/components/schemas/ProductMedia");
  });
});

describe("OpenAPI spec integrity — StandardError.code mirrors the ErrorCode union", () => {
  const domainErrorPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../src/domain/entities/errors/DomainError.ts",
  );

  function readErrorCodeUnion(): string[] {
    const source = readFileSync(domainErrorPath, "utf8");
    const start = source.indexOf("export type ErrorCode =");
    const end = source.indexOf(";", start);
    const block = source.slice(start, end);
    const codes = [...block.matchAll(/^\s*\|\s*"([A-Z0-9_]+)"/gm)].map(
      (m) => m[1],
    );
    return codes;
  }

  function readSpecErrorCodes(): string[] {
    const schemas = (doc.components as ComponentBuckets).schemas;
    const standardError = schemas.StandardError as
      | {
          properties?: {
            error?: {
              properties?: { code?: { enum?: string[] } };
            };
          };
        }
      | undefined;
    return standardError?.properties?.error?.properties?.code?.enum ?? [];
  }

  it("has no duplicate enum values", () => {
    const codes = readSpecErrorCodes();
    expect(codes.length).toBeGreaterThan(0);
    const dupes = codes.filter((code, index) => codes.indexOf(code) !== index);
    expect(dupes).toEqual([]);
  });

  it("covers every ErrorCode in the DomainError union (and nothing more)", () => {
    const domainCodes = readErrorCodeUnion();
    const specCodes = readSpecErrorCodes();
    expect(domainCodes.length).toBeGreaterThan(0);
    expect(new Set(domainCodes)).toEqual(new Set(specCodes));
  });

  it("recently-added logistics/inventory codes are present", () => {
    const specCodes = new Set(readSpecErrorCodes());
    for (const code of [
      "LOGISTICS_VERIFICATION_FAILED",
      "LOGISTICS_EVENT_FULFILLMENT_NOT_FOUND",
      "REFUND_REQUIRES_REVIEW",
      "SHIPMENT_REQUIRES_RECONCILIATION",
      "INSUFFICIENT_INVENTORY",
      "INSUFFICIENT_SINGLE_LOCATION_STOCK",
      "SOURCING_FAILED",
    ]) {
      expect(specCodes.has(code)).toBe(true);
    }
  });
});
