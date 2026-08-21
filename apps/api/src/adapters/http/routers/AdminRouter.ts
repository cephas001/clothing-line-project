// apps/api/src/adapters/http/routers/AdminRouter.ts

// HTTP adapter for the admin management endpoints (mounted at /admin):
//   POST  /admin/products                          -> CreateProductUseCase
//   POST  /admin/products/{id}/variants            -> CreateProductVariantUseCase
//   POST  /admin/variants/{id}/regional-prices     -> ConfigureRegionalPricingUseCase
//   POST  /admin/promotions                        -> CreatePromotionRuleUseCase
//   POST  /admin/sales-channels                    -> CreateSalesChannelUseCase
//   POST  /admin/categories                        -> ManageCategoriesUseCase.executeCreate
//   PUT   /admin/roles/{id}/permissions            -> ManageAdminRolePermissionsUseCase
//   POST  /admin/imports/bulk-catalog              -> ImportBulkCatalogDataUseCase
//   GET   /admin/queues/{queue_name}/dead-letter   -> ListDeadLetterJobsUseCase
//   POST  /admin/queues/{queue_name}/dead-letter/{job_id}/retry -> RetryDeadLetterJobUseCase
//   POST  /admin/draft-orders                      -> GenerateDraftOrderUseCase
//   POST  /admin/sourcing-location                 -> DetermineSourcingLocationUseCase
//   POST  /admin/carts/prune                       -> PruneAbandonedCartsUseCase
//
// These routes are the TRANSPORT BOUNDARY ONLY. They perform, in order:
//   HTTP request
//     -> validate/map input (path params + strict body contract)
//     -> resolve the authenticated actor from the bearer JWT (every /admin/*
//        path inherits bearerAuth; the token's customer identity is used as
//        the actor id for audit — see the identity note below)
//     -> the use case (source of truth) -> map the application result to the
//        provider-neutral response contract
// No SKU normalization, permission-set dedup, pricing, or queue logic exists
// here.
//
// Identity note (documented in the Phase F3 report):
//   - The OpenAPI spec marks every /admin/* operation with the shared
//     bearerAuth scheme. The only identity the transport can resolve is the
//     bearer JWT's customer identity; it is passed as `adminId` / `adminUserId`
//     so the use case's authorization + audit can act on it. This transport
//     does NOT perform admin authorization itself — the use cases own it
//     (IAuthorizationService.authorizeAdmin). When the token is missing the
//     request is rejected with 401 and the use case is never invoked.
//   - For import / dead-letter operations the use case field is named
//     `adminUserId`; the resolved actor id is mapped to that field.
//
// Response contract (matches the OpenAPI spec):
//   POST products/variants/sales-channels/categories   201  resource projection
//   POST imports/bulk-catalog                          202  { jobId }
//   POST draft-orders                                  201  { draftOrderId }
//   GET  queues/{queue_name}/dead-letter               200  DeadLetterJob[]
//   POST sourcing-location                             200  { locationId }
//   POST carts/prune                                   200  { deletedCount }
//   all other mutations                                204
//   400  VALIDATION_ERROR / INVALID_INPUT (malformed body / unknown fields)
//   401  UNAUTHORIZED_ACCESS (missing/invalid/expired bearer token)
//   404  RESOURCE_NOT_FOUND
//   409  INVALID_OPERATION / INVALID_STATE / INSUFFICIENT_PERMISSIONS
//   500  INTERNAL_ERROR
//
// Security: bearer tokens, secret keys, and credentials are never logged and
// never echoed into responses.

import express from "express";
import type { Request, Response } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type { CreateProductUseCase } from "@api/use-cases/admin/CreateProductUseCase";
import type { CreateProductVariantUseCase } from "@api/use-cases/admin/CreateProductVariantUseCase";
import type { ConfigureRegionalPricingUseCase } from "@api/use-cases/admin/ConfigureRegionalPricingUseCase";
import type { CreatePromotionRuleUseCase } from "@api/use-cases/admin/CreatePromotionRuleUseCase";
import type { CreateSalesChannelUseCase } from "@api/use-cases/admin/CreateSalesChannelUseCase";
import type { ManageCategoriesUseCase } from "@api/use-cases/admin/ManageCategoriesUseCase";
import type { ManageAdminRolePermissionsUseCase } from "@api/use-cases/admin/ManageAdminRolePermissionsUseCase";
import type { ImportBulkCatalogDataUseCase } from "@api/use-cases/admin/ImportBulkCatalogDataUseCase";
import type { ListDeadLetterJobsUseCase } from "@api/use-cases/admin/ListDeadLetterJobsUseCase";
import type { RetryDeadLetterJobUseCase } from "@api/use-cases/admin/RetryDeadLetterJobUseCase";
import type { GenerateDraftOrderUseCase } from "@api/use-cases/logistics/GenerateDraftOrderUseCase";
import type { DetermineSourcingLocationUseCase } from "@api/use-cases/inventory/DetermineSourcingLocationUseCase";
import type { PruneAbandonedCartsUseCase } from "@api/use-cases/cart/PruneAbandonedCartsUseCase";
import { resolveActorFromBearerToken } from "../middleware/auth";
import {
  parseStrictBodyObject,
  readQueryInt,
  readRequiredPathId,
} from "../middleware/body";
import {
  createBodyParseErrorHandler,
  mapDomainErrorToHttp,
  sendErrorResponse,
} from "../errors";
import {
  toCategoryResponse,
  toDeadLetterJobResponse,
  toProductResponse,
  toProductVariantResponse,
  toSalesChannelResponse,
} from "../projections";

const ADMIN_BODY_LIMIT = "100kb";
const DEAD_LETTER_DEFAULT_LIMIT = 20;
const DEAD_LETTER_MAX_LIMIT = 200;

const CREATE_PRODUCT_BODY_KEYS = [
  "title",
  "handle",
  "description",
] as const;
const CREATE_VARIANT_BODY_KEYS = [
  "sku",
  "inventoryQuantity",
  "allowBackorder",
] as const;
const REGIONAL_PRICING_BODY_KEYS = ["regionId", "amountMinor"] as const;
const CREATE_PROMOTION_BODY_KEYS = [
  "code",
  "discountType",
  "discountValueMinor",
  "minimumSpendMinor",
] as const;
const CREATE_SALES_CHANNEL_BODY_KEYS = [
  "name",
  "description",
  "isDisabled",
] as const;
const CREATE_CATEGORY_BODY_KEYS = ["name", "parentCategoryId"] as const;
const ROLE_PERMISSIONS_BODY_KEYS = ["permissions"] as const;
const BULK_IMPORT_BODY_KEYS = ["fileUrl", "fileType"] as const;
const DRAFT_ORDER_BODY_KEYS = [
  "email",
  "items",
  "shippingAddress",
  "adminId",
  "sendInvoice",
] as const;
const SOURCING_BODY_KEYS = [
  "variantId",
  "requestedQuantity",
  "customerCoordinates",
  "allowSplitAcrossLocations",
] as const;
const PRUNE_BODY_KEYS = ["expirationDateThreshold"] as const;

export interface AdminRouterDeps {
  createProduct: CreateProductUseCase;
  createProductVariant: CreateProductVariantUseCase;
  configureRegionalPricing: ConfigureRegionalPricingUseCase;
  createPromotionRule: CreatePromotionRuleUseCase;
  createSalesChannel: CreateSalesChannelUseCase;
  manageCategories: ManageCategoriesUseCase;
  manageAdminRolePermissions: ManageAdminRolePermissionsUseCase;
  importBulkCatalogData: ImportBulkCatalogDataUseCase;
  listDeadLetterJobs: ListDeadLetterJobsUseCase;
  retryDeadLetterJob: RetryDeadLetterJobUseCase;
  generateDraftOrder: GenerateDraftOrderUseCase;
  determineSourcingLocation: DetermineSourcingLocationUseCase;
  pruneAbandonedCarts: PruneAbandonedCartsUseCase;
  /** Verifies the bearer JWT into the actor identity used as the admin id. */
  tokenService: ITokenService;
  logger: ILogger;
}

export function createAdminRouter(deps: AdminRouterDeps): express.Router {
  const router = express.Router();

  // POST /admin/products — create a product.
  router.post(
    "/products",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const adminId = await requireAdmin(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          CREATE_PRODUCT_BODY_KEYS,
          ["title", "handle"],
        );
        const product = await deps.createProduct.execute({
          adminId,
          title: body.title as string,
          handle: body.handle as string,
          description:
            typeof body.description === "string"
              ? (body.description as string)
              : undefined,
        });
        res.status(201).json(toProductResponse(product));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Create product");
      }
    },
  );

  // POST /admin/products/{id}/variants — create a product variant.
  router.post(
    "/products/:id/variants",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const adminId = await requireAdmin(req, deps.tokenService);
        const productId = readRequiredPathId(req.params.id, "productId");
        const body = parseStrictBodyObject(
          req.body,
          CREATE_VARIANT_BODY_KEYS,
          ["sku", "inventoryQuantity", "allowBackorder"],
        );
        const variant = await deps.createProductVariant.execute({
          adminId,
          productId,
          sku: body.sku as string,
          inventoryQuantity: body.inventoryQuantity as number,
          allowBackorder: body.allowBackorder as boolean,
        });
        res.status(201).json(toProductVariantResponse(variant, null));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Create product variant");
      }
    },
  );

  // POST /admin/variants/{id}/regional-prices — configure a regional price.
  router.post(
    "/variants/:id/regional-prices",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const adminId = await requireAdmin(req, deps.tokenService);
        const variantId = readRequiredPathId(req.params.id, "variantId");
        const body = parseStrictBodyObject(
          req.body,
          REGIONAL_PRICING_BODY_KEYS,
          ["regionId", "amountMinor"],
        );
        await deps.configureRegionalPricing.execute({
          adminId,
          variantId,
          regionId: body.regionId as string,
          amountMinor: body.amountMinor as number,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Configure regional pricing");
      }
    },
  );

  // POST /admin/promotions — create a promotion rule.
  router.post(
    "/promotions",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const adminId = await requireAdmin(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          CREATE_PROMOTION_BODY_KEYS,
          ["code", "discountType", "discountValueMinor"],
        );
        await deps.createPromotionRule.execute({
          adminId,
          code: body.code as string,
          discountType: body.discountType as "percentage" | "fixed_amount",
          discountValueMinor: body.discountValueMinor as number,
          minimumSpendMinor:
            typeof body.minimumSpendMinor === "number"
              ? (body.minimumSpendMinor as number)
              : undefined,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Create promotion rule");
      }
    },
  );

  // POST /admin/sales-channels — create a sales channel.
  router.post(
    "/sales-channels",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const adminId = await requireAdmin(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          CREATE_SALES_CHANNEL_BODY_KEYS,
          ["name"],
        );
        const salesChannel = await deps.createSalesChannel.execute({
          adminId,
          name: body.name as string,
          description:
            typeof body.description === "string"
              ? (body.description as string)
              : undefined,
          isDisabled:
            typeof body.isDisabled === "boolean"
              ? (body.isDisabled as boolean)
              : undefined,
        });
        res.status(201).json(toSalesChannelResponse(salesChannel));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Create sales channel");
      }
    },
  );

  // POST /admin/categories — create a product category.
  router.post(
    "/categories",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const adminId = await requireAdmin(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          CREATE_CATEGORY_BODY_KEYS,
          ["name"],
        );
        const category = await deps.manageCategories.executeCreate({
          adminId,
          name: body.name as string,
          parentCategoryId:
            typeof body.parentCategoryId === "string"
              ? (body.parentCategoryId as string)
              : undefined,
        });
        res.status(201).json(toCategoryResponse(category));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Create category");
      }
    },
  );

  // PUT /admin/roles/{id}/permissions — replace a role's permission set.
  router.put(
    "/roles/:id/permissions",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const adminId = await requireAdmin(req, deps.tokenService);
        const roleId = readRequiredPathId(req.params.id, "roleId");
        const body = parseStrictBodyObject(
          req.body,
          ROLE_PERMISSIONS_BODY_KEYS,
          ["permissions"],
        );
        const permissions = readStringArray(body.permissions);
        await deps.manageAdminRolePermissions.execute({
          adminId,
          roleId,
          permissions,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Manage role permissions");
      }
    },
  );

  // POST /admin/imports/bulk-catalog — enqueue a bulk catalog import job.
  router.post(
    "/imports/bulk-catalog",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const adminUserId = await requireAdmin(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          BULK_IMPORT_BODY_KEYS,
          ["fileUrl"],
        );
        const result = await deps.importBulkCatalogData.execute({
          adminUserId,
          fileUrl: body.fileUrl as string,
          fileType: readFileType(body.fileType),
        });
        res.status(202).json({ jobId: result.jobId });
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Import bulk catalog");
      }
    },
  );

  // GET /admin/queues/{queue_name}/dead-letter — list dead-letter jobs.
  router.get(
    "/queues/:queue_name/dead-letter",
    async (req: Request, res: Response) => {
      try {
        const adminUserId = await requireAdmin(req, deps.tokenService);
        const queueName = readRequiredPathId(req.params.queue_name, "queueName");
        const limit = readQueryInt(
          req.query.limit,
          "limit",
          1,
          DEAD_LETTER_MAX_LIMIT,
          DEAD_LETTER_DEFAULT_LIMIT,
        );
        const offset = readQueryInt(req.query.offset, "offset", 0, 10_000_000, 0);
        const jobs = await deps.listDeadLetterJobs.execute({
          adminUserId,
          queueName,
          limit,
          offset,
        });
        res.status(200).json(jobs.map(toDeadLetterJobResponse));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "List dead-letter jobs");
      }
    },
  );

  // POST /admin/queues/{queue_name}/dead-letter/{job_id}/retry — retry a job.
  router.post(
    "/queues/:queue_name/dead-letter/:job_id/retry",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const adminUserId = await requireAdmin(req, deps.tokenService);
        const queueName = readRequiredPathId(req.params.queue_name, "queueName");
        const jobId = readRequiredPathId(req.params.job_id, "jobId");
        await deps.retryDeadLetterJob.execute({
          adminUserId,
          queueName,
          jobId,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Retry dead-letter job");
      }
    },
  );

  // POST /admin/draft-orders — generate a draft order + optional invoice.
  router.post(
    "/draft-orders",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const actorId = await requireAdmin(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          DRAFT_ORDER_BODY_KEYS,
          ["email", "items", "shippingAddress", "adminId"],
        );
        // Cross-check: the body adminId must equal the token identity. The use
        // case records adminId; the transport never trusts a foreign body id.
        if (actorId !== (body.adminId as string)) {
          throw new DomainError(
            "PERMISSION_DENIED",
            "The adminId does not match the authenticated admin.",
          );
        }
        const draftOrderId = await deps.generateDraftOrder.execute({
          email: body.email as string,
          items: readDraftOrderItems(body.items),
          shippingAddress: body.shippingAddress as Record<string, unknown>,
          adminId: actorId,
          actorId,
          sendInvoice:
            typeof body.sendInvoice === "boolean"
              ? (body.sendInvoice as boolean)
              : undefined,
        });
        res.status(201).json({ draftOrderId });
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Generate draft order");
      }
    },
  );

  // POST /admin/sourcing-location — determine the optimal sourcing location.
  router.post(
    "/sourcing-location",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const actorId = await requireAdmin(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          SOURCING_BODY_KEYS,
          ["variantId", "requestedQuantity"],
        );
        const result = await deps.determineSourcingLocation.execute({
          variantId: body.variantId as string,
          requestedQuantity: body.requestedQuantity as number,
          customerCoordinates: readCoordinates(body.customerCoordinates),
          allowSplitAcrossLocations:
            typeof body.allowSplitAcrossLocations === "boolean"
              ? (body.allowSplitAcrossLocations as boolean)
              : undefined,
          actorId,
        });
        res.status(200).json({ locationId: result });
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Determine sourcing location");
      }
    },
  );

  // POST /admin/carts/prune — prune abandoned carts.
  router.post(
    "/carts/prune",
    express.json({ limit: ADMIN_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        await requireAdmin(req, deps.tokenService);
        const body = parseStrictBodyObject(
          req.body,
          PRUNE_BODY_KEYS,
          ["expirationDateThreshold"],
        );
        const threshold = readIsoDate(body.expirationDateThreshold);
        const result = await deps.pruneAbandonedCarts.execute({
          expirationDateThreshold: threshold,
        });
        res.status(200).json({ deletedCount: result.deletedCount });
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Prune abandoned carts");
      }
    },
  );

  // express.json errors (malformed body, oversized payload) never reach the
  // route handler; map them to the standard envelope.
  router.use(createBodyParseErrorHandler(deps.logger, "Admin"));

  return router;
}

/**
 * Resolve the authenticated admin from the bearer JWT. Every /admin/* path
 * inherits bearerAuth; a missing/invalid token is a 401 and the use case is
 * never invoked. The resolved actor identity is the audit admin id.
 */
async function requireAdmin(
  req: Request,
  tokenService: ITokenService,
): Promise<string> {
  const actorId = await resolveActorFromBearerToken(req, tokenService);
  if (!actorId) {
    throw new DomainError("UNAUTHORIZED_ACCESS", "Admin authentication required.");
  }
  return actorId;
}

/** Read an optional bulk-import file type hint (csv|json). */
function readFileType(value: unknown): "csv" | "json" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "csv" && value !== "json") {
    throw new DomainError(
      "VALIDATION_ERROR",
      "fileType must be 'csv' or 'json' when provided.",
    );
  }
  return value;
}

/** Read a non-empty string array (role permissions). */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "permissions must be a non-empty array of strings.",
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `permissions[${index}] must be a non-empty string.`,
      );
    }
    return entry.trim();
  });
}

/** Read and validate the draft-order items array. */
function readDraftOrderItems(
  value: unknown,
): Array<{ title: string; quantity: number; unitPriceMinor: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "items must be a non-empty array.",
    );
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Item at index ${index} must be an object.`,
      );
    }
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title : "";
    const quantity = Number(item.quantity);
    const unitPriceMinor = Number(item.unitPriceMinor);
    if (!title) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Item at index ${index} must include a title.`,
      );
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Item at index ${index} quantity must be a positive integer.`,
      );
    }
    if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Item at index ${index} unitPriceMinor must be a non-negative integer.`,
      );
    }
    return { title, quantity, unitPriceMinor };
  });
}

/** Read optional customer coordinates (both lat and lng required together). */
function readCoordinates(
  value: unknown,
): { lat: number; lng: number } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "customerCoordinates must be an object with lat and lng.",
    );
  }
  const record = value as Record<string, unknown>;
  const lat = Number(record.lat);
  const lng = Number(record.lng);
  if (
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "customerCoordinates lat/lng are out of range.",
    );
  }
  return { lat, lng };
}

/** Parse an ISO-8601 date-time string into a Date. */
function readIsoDate(value: unknown): Date {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "expirationDateThreshold must be an ISO-8601 date-time string.",
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "expirationDateThreshold is not a valid date-time.",
    );
  }
  return parsed;
}

/** Map a thrown error to the canonical envelope + log the rejection. */
function handleError(
  err: unknown,
  res: Response,
  logger: ILogger,
  context: string,
): void {
  const mapped = mapDomainErrorToHttp(err);
  logger.warn(`${context} request rejected`, {
    status: mapped.status,
    code: mapped.code,
  });
  sendErrorResponse(res, mapped);
}