// apps/api/src/adapters/http/routers/CatalogRouter.ts

// HTTP adapter for the storefront catalogue endpoints:
//   GET  /products                     -> BrowseCatalogUseCase
//   GET  /products/search              -> SearchProductsUseCase (wired only with a search service)
//   GET  /products/:id                 -> GetProductDetailsUseCase
//   GET  /products/:id/related         -> ResolveCrossSellingProductsUseCase (wired only with a recommendation engine)
//   POST /products/:id/reviews         -> SubmitProductReviewUseCase (bearer auth REQUIRED)
//   GET  /variants/:id/availability    -> GetVariantAvailabilityUseCase (wired only with a pricing service)
//   GET  /product-categories           -> RetrieveCategoryTreeUseCase
//
// Pure TRANSPORT BOUNDARY: parse query/headers/path -> use case -> explicit
// public projection. No catalog, pricing, or review logic lives here. The use
// cases own visibility/pricing/verified-buyer rules. Domain entities are NEVER
// serialized directly: every Product/Variant is reduced through the public
// projections in ../projections (the OpenAPI Product contract fields only —
// internal underscore state and category/sales-channel membership stay
// server-side).
//
// Boundary rules:
//   - sales_channel_id / region_id context headers are OPTIONAL at the
//     transport; the use case decides whether they are required (400 when a
//     required context is missing). The transport never hard-codes it.
//   - expand/fields on GET /products/:id are passed through as CSV lists.
//   - POST /products/:id/reviews REQUIRES a valid bearer token; the customerId
//     comes from the token ONLY (a client-supplied customerId is rejected).
//   - Routes whose use case is unwired are NOT registered (requests 404); they
//     are never faked.
//
// Response contract:
//   200  public projections (ProductList, Product[], Product,
//        VariantAvailability, Category[])
//   201  { success: true } for a submitted review
//   400  VALIDATION_ERROR (malformed query/body, missing required context)
//   401  UNAUTHORIZED_ACCESS (missing/invalid bearer on reviews)
//   403  UNAUTHORIZED_REVIEW (non-verified buyer) / PERMISSION_DENIED
//   404  PRODUCT_NOT_FOUND / RESOURCE_NOT_FOUND
//   409  INVALID_OPERATION (duplicate review)
//   500  INTERNAL_ERROR / EXTERNAL_SERVICE_*
//
// Security: bearer tokens, API keys, and stack traces are never logged or
// echoed into responses.

import express from "express";
import type { Request, Response } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type { BrowseCatalogUseCase } from "@api/use-cases/catalog/BrowseCatalogUseCase";
import type { GetProductDetailsUseCase } from "@api/use-cases/catalog/GetProductDetailsUseCase";
import type { GetVariantAvailabilityUseCase } from "@api/use-cases/catalog/GetVariantAvailabilityUseCase";
import type { ResolveCrossSellingProductsUseCase } from "@api/use-cases/catalog/ResolveCrossSellingProductsUseCase";
import type { RetrieveCategoryTreeUseCase } from "@api/use-cases/catalog/RetrieveCategoryTreeUseCase";
import type { SearchProductsUseCase } from "@api/use-cases/catalog/SearchProductsUseCase";
import type { SubmitProductReviewUseCase } from "@api/use-cases/catalog/SubmitProductReviewUseCase";
import { resolveActorAndTokenFromBearerToken } from "../middleware/auth";
import {
  parseStrictBodyObject,
  readOptionalHeader,
  readQueryBoolean,
  readQueryInt,
  readQueryString,
  readRequiredPathId,
  readRequiredQueryString,
  splitCsv,
} from "../middleware/body";
import {
  createBodyParseErrorHandler,
  mapDomainErrorToHttp,
  sendErrorResponse,
} from "../errors";
import {
  toProductListResponse,
  toProductResponse,
} from "../projections";

const REVIEW_BODY_LIMIT = "100kb";
const REVIEW_BODY_KEYS = ["rating", "comment"] as const;

export interface CatalogRouterDeps {
  /** Always wired: depends only on core dependencies. */
  browseCatalog: BrowseCatalogUseCase;
  /** Always wired. */
  getProductDetails: GetProductDetailsUseCase;
  /** Always wired. */
  retrieveCategoryTree: RetrieveCategoryTreeUseCase;
  /** Always wired. */
  submitProductReview: SubmitProductReviewUseCase;
  /** Present only when a search service is configured. */
  searchProducts?: SearchProductsUseCase;
  /** Present only when a recommendation engine is configured. */
  resolveCrossSellingProducts?: ResolveCrossSellingProductsUseCase;
  /** Present only when the regional pricing service is configured. */
  getVariantAvailability?: GetVariantAvailabilityUseCase;
  /** Verifies the bearer JWT on authenticated routes (reviews). */
  tokenService: ITokenService;
  logger: ILogger;
}

export function createCatalogRouter(deps: CatalogRouterDeps): express.Router {
  const router = express.Router();

  // GET /products — paginated, region/channel-scoped catalogue browse.
  router.get("/products", async (req: Request, res: Response) => {
    try {
      const result = await deps.browseCatalog.execute({
        salesChannelId: readOptionalHeader(req, "sales_channel_id") ?? "",
        regionId: readOptionalHeader(req, "region_id") ?? "",
        categoryId: readQueryString(req.query.categoryId, "categoryId"),
        searchQuery: readQueryString(req.query.searchQuery, "searchQuery"),
        limit: readQueryInt(req.query.limit, "limit", 1, 200, 20),
        offset: readQueryInt(req.query.offset, "offset", 0, 10_000_000, 0),
      });
      // Explicit public projection: domain entities are never serialized
      // directly (they would leak internal underscore state and drop the
      // contract fields). See ../projections.
      res.status(200).json(toProductListResponse(result));
    } catch (err: unknown) {
      rejectRequest(deps.logger, res, err, "Catalogue browse");
    }
  });

  // GET /products/search — full-text search. MUST precede /products/:id so the
  // literal "search" segment is never captured as a product id.
  if (deps.searchProducts) {
    router.get("/products/search", async (req: Request, res: Response) => {
      try {
        const result = await deps.searchProducts!.execute({
          query: readRequiredQueryString(req.query.query, "query"),
          salesChannelId: readOptionalHeader(req, "sales_channel_id") ?? "",
          regionId: readOptionalHeader(req, "region_id") ?? "",
          limit: readQueryInt(req.query.limit, "limit", 1, 200, 12),
        });
        res.status(200).json(result.map(toProductResponse));
      } catch (err: unknown) {
        rejectRequest(deps.logger, res, err, "Product search");
      }
    });
  } else {
    // No search service configured: the capability is NOT available. Register a
    // 404 route explicitly so the literal "search" segment can never fall
    // through to the /products/:id handler as a bogus product id.
    router.get("/products/search", (req: Request, res: Response) => {
      rejectRequest(
        deps.logger,
        res,
        new DomainError(
          "RESOURCE_NOT_FOUND",
          "Product search is not available.",
        ),
        "Product search",
      );
    });
  }

  // GET /products/:id — detailed product for a store context.
  router.get("/products/:id", async (req: Request, res: Response) => {
    try {
      const product = await deps.getProductDetails.execute({
        productId: readRequiredPathId(req.params.id, "productId"),
        salesChannelId: readOptionalHeader(req, "sales_channel_id") ?? "",
        regionId: readOptionalHeader(req, "region_id") ?? "",
        expand: splitCsv(readQueryString(req.query.expand, "expand")),
        fields: splitCsv(readQueryString(req.query.fields, "fields")),
      });
      res.status(200).json(toProductResponse(product));
    } catch (err: unknown) {
      rejectRequest(deps.logger, res, err, "Product details");
    }
  });

  // GET /products/:id/related — cross-selling recommendations.
  if (deps.resolveCrossSellingProducts) {
    router.get(
      "/products/:id/related",
      async (req: Request, res: Response) => {
        try {
          const result = await deps.resolveCrossSellingProducts!.execute({
            productId: readRequiredPathId(req.params.id, "productId"),
            salesChannelId: readOptionalHeader(req, "sales_channel_id") ?? "",
            regionId: readOptionalHeader(req, "region_id") ?? "",
            limit: readQueryInt(req.query.limit, "limit", 1, 50, 4),
          });
          res.status(200).json(result.map(toProductResponse));
        } catch (err: unknown) {
          rejectRequest(deps.logger, res, err, "Related products");
        }
      },
    );
  }

  // POST /products/:id/reviews — verified-buyer review submission.
  router.post(
    "/products/:id/reviews",
    express.json({ limit: REVIEW_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const productId = readRequiredPathId(req.params.id, "productId");

        // Reviews REQUIRE a verified identity; the customerId comes from the
        // bearer token ONLY (a client-supplied customerId is rejected below).
        const resolved = await resolveActorAndTokenFromBearerToken(
          req,
          deps.tokenService,
        );
        if (!resolved) {
          throw new DomainError(
            "UNAUTHORIZED_ACCESS",
            "Authentication required.",
          );
        }

        const body = parseStrictBodyObject(req.body, REVIEW_BODY_KEYS, [
          "rating",
        ]);
        const rating =
          typeof body.rating === "number" ? body.rating : NaN;
        const comment =
          typeof body.comment === "string" ? body.comment.trim() : undefined;

        await deps.submitProductReview.execute({
          productId,
          customerId: resolved.customerId,
          rating,
          comment,
          actorId: resolved.customerId,
        });

        res.status(201).json({ success: true });
      } catch (err: unknown) {
        rejectRequest(deps.logger, res, err, "Review submission");
      }
    },
  );

  // GET /variants/:id/availability — inventory + regional price for a variant.
  if (deps.getVariantAvailability) {
    router.get(
      "/variants/:id/availability",
      async (req: Request, res: Response) => {
        try {
          const result = await deps.getVariantAvailability!.execute({
            variantId: readRequiredPathId(req.params.id, "variantId"),
            regionId: readOptionalHeader(req, "region_id") ?? "",
          });
          res.status(200).json(result);
        } catch (err: unknown) {
          rejectRequest(deps.logger, res, err, "Variant availability");
        }
      },
    );
  }

  // GET /product-categories — the category tree (flat list, parent pointers).
  router.get("/product-categories", async (req: Request, res: Response) => {
    try {
      const result = await deps.retrieveCategoryTree.execute({
        includeDescendants: readQueryBoolean(
          req.query.includeDescendants,
          "includeDescendants",
          true,
        ),
      });
      res.status(200).json(result);
    } catch (err: unknown) {
      rejectRequest(deps.logger, res, err, "Category tree");
    }
  });

  // express.json errors on the review route never reach the handler; map them
  // to the standard envelope.
  router.use(createBodyParseErrorHandler(deps.logger, "Catalog"));

  return router;
}

/** Log a rejected request and answer with the canonical error envelope. */
function rejectRequest(
  logger: ILogger,
  res: Response,
  err: unknown,
  context: string,
): void {
  const mapped = mapDomainErrorToHttp(err);
  logger.warn(`${context} request rejected`, {
    status: mapped.status,
    code: mapped.code,
  });
  sendErrorResponse(res, mapped);
}
