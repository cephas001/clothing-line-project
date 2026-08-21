// apps/api/src/adapters/http/routers/CartRouter.ts

// HTTP adapter for the cart lifecycle endpoints (mounted at /store/carts):
//   GET    /store/carts/{id}                        -> GetCartUseCase
//   POST   /store/carts                            -> InitializeCartSessionUseCase
//   POST   /store/carts/{id}/line-items            -> AddCartLineItemUseCase
//   POST   /store/carts/{id}/line-items/custom     -> AddCustomLineItemUseCase
//   PUT    /store/carts/{id}/line-items/{line_id}  -> UpdateLineItemQuantityUseCase
//   DELETE /store/carts/{id}/line-items/{line_id}  -> RemoveCartLineItemUseCase
//   POST   /store/carts/{id}/discount              -> ApplyDiscountCodeUseCase
//   POST   /store/carts/{id}/merge                 -> MergeGuestCartToCustomerUseCase
//   PUT    /store/carts/{id}/shipping-address      -> SetCheckoutShippingAddressUseCase
//
// These routes are the TRANSPORT BOUNDARY ONLY. They perform, in order:
//   HTTP request
//     -> validate/map input (path params + strict body contract)
//     -> resolve the authenticated actor from the bearer JWT when presented
//        (guest cart flows remain supported; a customerId is NEVER accepted from
//        the request body except on merge, where the body identity MUST match
//        the authenticated token)
//     -> the use case (source of truth) -> map the application result to the
//        provider-neutral response contract
// No pricing, inventory, promotion, or financial logic exists here.
//
// Identity rules (L5/PART 13):
//   - a customerId is NEVER read from the body on line-item / discount /
//     shipping-address routes — the optional JWT is the only identity source;
//   - merge REQUIRES a valid bearer token (the OpenAPI operation inherits
//     bearerAuth) and the body `customerId` MUST equal the token's identity
//     (PERMISSION_DENIED otherwise).
//
// Response contract:
//   GET  /store/carts/{id}                 200  Cart (public projection)
//   POST /store/carts                      200  Cart (public projection)
//   POST line-items / custom / discount    204
//   PUT line-items / shipping-address      204
//   DELETE line-items                      204
//   POST merge                             204
//   400  VALIDATION_ERROR / INVALID_INPUT (malformed body / unknown fields)
//   401  UNAUTHORIZED_ACCESS (invalid, expired, or malformed bearer token)
//   403  PERMISSION_DENIED (authenticated actor does not own the cart)
//   404  CART_NOT_FOUND / RESOURCE_NOT_FOUND / REGION_NOT_FOUND
//   409  OUT_OF_STOCK / REGIONAL_PRICE_MISSING / INVALID_OPERATION / etc.
//   500  INTERNAL_ERROR
//
// Security: bearer tokens and internal stack traces are never logged and never
// echoed into responses.

import express from "express";
import type { Request, Response } from "express";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { InitializeCartSessionUseCase } from "@api/use-cases/cart/InitializeCartSessionUseCase";
import type { GetCartUseCase } from "@api/use-cases/cart/GetCartUseCase";
import type { AddCartLineItemUseCase } from "@api/use-cases/cart/AddCartLineItemUseCase";
import type { AddCustomLineItemUseCase } from "@api/use-cases/cart/AddCustomLineItemUseCase";
import type { UpdateLineItemQuantityUseCase } from "@api/use-cases/cart/UpdateLineItemQuantityUseCase";
import type { RemoveCartLineItemUseCase } from "@api/use-cases/cart/RemoveCartLineItemUseCase";
import type { ApplyDiscountCodeUseCase } from "@api/use-cases/cart/ApplyDiscountCodeUseCase";
import type { MergeGuestCartToCustomerUseCase } from "@api/use-cases/cart/MergeGuestCartToCustomerUseCase";
import type { SetCheckoutShippingAddressUseCase } from "@api/use-cases/checkout/SetCheckoutShippingAddressUseCase";
import { resolveActorFromBearerToken } from "../middleware/auth";
import {
  assertEmptyRequestBody,
  parseStrictBodyObject,
  readRequiredPathId,
} from "../middleware/body";
import {
  createBodyParseErrorHandler,
  mapDomainErrorToHttp,
  sendErrorResponse,
} from "../errors";
import { toCartResponse } from "../projections";
const CART_BODY_LIMIT = "100kb";

const INITIALIZE_BODY_KEYS = ["regionId", "salesChannelId", "email", "countryCode"] as const;
const ADD_LINE_ITEM_BODY_KEYS = ["variantId", "quantity", "metadata"] as const;
const ADD_CUSTOM_LINE_ITEM_BODY_KEYS = ["title", "quantity", "unitPriceMinor"] as const;
const UPDATE_QUANTITY_BODY_KEYS = ["quantity"] as const;
const APPLY_DISCOUNT_BODY_KEYS = ["code"] as const;
const MERGE_BODY_KEYS = ["guestCartId", "customerId"] as const;
const SHIPPING_ADDRESS_BODY_KEYS = ["shippingAddress"] as const;

export interface CartRouterDeps {
  initializeCartSession: InitializeCartSessionUseCase;
  /** Read-only cart retrieval; always wired (depends only on core deps). */
  getCart: GetCartUseCase;
  /**
   * Present only when the pricing service is configured. When absent the
   * variant line-item route is not registered (requests receive a 404); it is
   * never faked.
   */
  addCartLineItem?: AddCartLineItemUseCase;
  addCustomLineItem: AddCustomLineItemUseCase;
  updateLineItemQuantity: UpdateLineItemQuantityUseCase;
  removeCartLineItem: RemoveCartLineItemUseCase;
  applyDiscountCode: ApplyDiscountCodeUseCase;
  mergeGuestCartToCustomer: MergeGuestCartToCustomerUseCase;
  /**
   * Present only when the tax service is configured (it always is in the API
   * runtime). When absent the shipping-address route is not registered.
   */
  setCheckoutShippingAddress?: SetCheckoutShippingAddressUseCase;
  /** Verifies the optional bearer JWT (POST /store/auth) into the actor identity. */
  tokenService: ITokenService;
  logger: ILogger;
}

export function createCartRouter(deps: CartRouterDeps): express.Router {
  const router = express.Router();

  // POST /store/carts — initialize a transient cart bound to a region/channel.
  router.post(
    "/",
    express.json({ limit: CART_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const body = parseStrictBodyObject(
          req.body,
          INITIALIZE_BODY_KEYS,
          ["regionId", "salesChannelId"],
        );
        const cart = await deps.initializeCartSession.execute({
          regionId: body.regionId as string,
          salesChannelId: body.salesChannelId as string,
          email: typeof body.email === "string" ? body.email : undefined,
          countryCode:
            typeof body.countryCode === "string" ? body.countryCode : undefined,
        });
        res.status(200).json(toCartResponse(cart));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Initialize cart");
      }
    },
  );

  // GET /store/carts/:id — retrieve the current cart state (public read).
  // The use case enforces customer ownership when a bearer identity is present.
  router.get(
    "/:id",
    async (req: Request, res: Response) => {
      try {
        const cartId = readRequiredPathId(req.params.id, "cartId");
        const actorId = await resolveActorFromBearerToken(
          req,
          deps.tokenService,
        );
        const cart = await deps.getCart.execute({
          cartId,
          actorId: actorId ?? undefined,
        });
        res.status(200).json(toCartResponse(cart));
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Get cart");
      }
    },
  );

  // POST /store/carts/:id/line-items — add a variant line item (pricing-gated).
  if (deps.addCartLineItem) {
    router.post(
      "/:id/line-items",
      express.json({ limit: CART_BODY_LIMIT }),
      async (req: Request, res: Response) => {
        try {
          const cartId = readRequiredPathId(req.params.id, "cartId");
          const body = parseStrictBodyObject(
            req.body,
            ADD_LINE_ITEM_BODY_KEYS,
            ["variantId", "quantity"],
          );
          const actorId = await resolveActorFromBearerToken(
            req,
            deps.tokenService,
          );
          await deps.addCartLineItem!.execute({
            cartId,
            variantId: body.variantId as string,
            quantity: body.quantity as number,
            metadata:
              body.metadata && typeof body.metadata === "object"
                ? (body.metadata as Record<string, unknown>)
                : undefined,
            actorId: actorId ?? "system",
          });
          res.status(204).end();
        } catch (err: unknown) {
          handleError(err, res, deps.logger, "Add cart line item");
        }
      },
    );
  }

  // POST /store/carts/:id/line-items/custom — add a B2B custom line item.
  router.post(
    "/:id/line-items/custom",
    express.json({ limit: CART_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const cartId = readRequiredPathId(req.params.id, "cartId");
        const body = parseStrictBodyObject(
          req.body,
          ADD_CUSTOM_LINE_ITEM_BODY_KEYS,
          ["title", "quantity", "unitPriceMinor"],
        );
        const actorId = await resolveActorFromBearerToken(
          req,
          deps.tokenService,
        );
        await deps.addCustomLineItem.execute({
          cartId,
          title: body.title as string,
          quantity: body.quantity as number,
          unitPriceMinor: body.unitPriceMinor as number,
          actorId: actorId ?? "system",
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Add custom cart line item");
      }
    },
  );

  // PUT /store/carts/:id/line-items/:line_id — update a line item quantity.
  router.put(
    "/:id/line-items/:line_id",
    express.json({ limit: CART_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const cartId = readRequiredPathId(req.params.id, "cartId");
        const lineItemId = readRequiredPathId(req.params.line_id, "lineItemId");
        const body = parseStrictBodyObject(
          req.body,
          UPDATE_QUANTITY_BODY_KEYS,
          ["quantity"],
        );
        const actorId = await resolveActorFromBearerToken(
          req,
          deps.tokenService,
        );
        await deps.updateLineItemQuantity.execute({
          cartId,
          lineItemId,
          quantity: body.quantity as number,
          actorId: actorId ?? "system",
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Update cart line item quantity");
      }
    },
  );

  // DELETE /store/carts/:id/line-items/:line_id — remove a line item.
  router.delete(
    "/:id/line-items/:line_id",
    express.json({ limit: CART_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const cartId = readRequiredPathId(req.params.id, "cartId");
        const lineItemId = readRequiredPathId(req.params.line_id, "lineItemId");
        const actorId = await resolveActorFromBearerToken(
          req,
          deps.tokenService,
        );
        await deps.removeCartLineItem.execute({
          cartId,
          lineItemId,
          actorId: actorId ?? "system",
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Remove cart line item");
      }
    },
  );

  // POST /store/carts/:id/discount — apply a promotion code.
  router.post(
    "/:id/discount",
    express.json({ limit: CART_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const cartId = readRequiredPathId(req.params.id, "cartId");
        const body = parseStrictBodyObject(req.body, APPLY_DISCOUNT_BODY_KEYS, [
          "code",
        ]);
        const actorId = await resolveActorFromBearerToken(
          req,
          deps.tokenService,
        );
        await deps.applyDiscountCode.execute({
          cartId,
          code: body.code as string,
          actorId: actorId ?? "system",
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Apply cart discount");
      }
    },
  );

  // POST /store/carts/:id/merge — merge a guest cart into the customer's cart.
  router.post(
    "/:id/merge",
    express.json({ limit: CART_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const guestCartId = readRequiredPathId(req.params.id, "guestCartId");
        const body = parseStrictBodyObject(req.body, MERGE_BODY_KEYS, [
          "guestCartId",
          "customerId",
        ]);
        // Merge inherits bearerAuth: the caller MUST present a valid token, and
        // the body identity MUST equal the token identity (ownership check).
        const actorId = await resolveActorFromBearerToken(
          req,
          deps.tokenService,
        );
        if (!actorId) {
          throw new DomainError(
            "UNAUTHORIZED_ACCESS",
            "Authentication required.",
          );
        }
        if (actorId !== (body.customerId as string)) {
          throw new DomainError(
            "PERMISSION_DENIED",
            "The customerId does not match the authenticated customer.",
          );
        }
        await deps.mergeGuestCartToCustomer.execute({
          guestCartId,
          customerId: body.customerId as string,
          actorId,
        });
        res.status(204).end();
      } catch (err: unknown) {
        handleError(err, res, deps.logger, "Merge guest cart");
      }
    },
  );

  // PUT /store/carts/:id/shipping-address — set the checkout address (tax-gated).
  if (deps.setCheckoutShippingAddress) {
    router.put(
      "/:id/shipping-address",
      express.json({ limit: CART_BODY_LIMIT }),
      async (req: Request, res: Response) => {
        try {
          const cartId = readRequiredPathId(req.params.id, "cartId");
          const body = parseStrictBodyObject(
            req.body,
            SHIPPING_ADDRESS_BODY_KEYS,
            ["shippingAddress"],
          );
          const shippingAddress = body.shippingAddress;
          if (
            typeof shippingAddress !== "object" ||
            shippingAddress === null ||
            Array.isArray(shippingAddress)
          ) {
            throw new DomainError(
              "VALIDATION_ERROR",
              "shippingAddress must be an object.",
            );
          }
          const actorId = await resolveActorFromBearerToken(
            req,
            deps.tokenService,
          );
          await deps.setCheckoutShippingAddress!.execute({
            cartId,
            shippingAddress: shippingAddress as Record<string, unknown>,
            actorId: actorId ?? "system",
          });
          res.status(204).end();
        } catch (err: unknown) {
          handleError(err, res, deps.logger, "Set cart shipping address");
        }
      },
    );
  }

  // express.json errors (malformed body, oversized payload) never reach the
  // route handler; map them to the standard envelope.
  router.use(createBodyParseErrorHandler(deps.logger, "Cart"));

  return router;
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