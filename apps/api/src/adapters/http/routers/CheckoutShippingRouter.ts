// apps/api/src/adapters/http/routers/CheckoutShippingRouter.ts

// HTTP adapter for the checkout shipping endpoints:
//   POST /store/carts/:id/shipping-quotes   -> RetrieveDynamicShippingQuotesUseCase
//   POST /store/carts/:id/shipping-options  -> SelectShippingOptionUseCase
//
// Both endpoints are the TRANSPORT BOUNDARY ONLY. They perform, in order:
//   HTTP request
//     -> validate/map input (path cartId; for selection: body { quoteId })
//     -> resolve the authenticated actor from the bearer JWT when presented
//        (guest checkout remains supported; a customerId is NEVER accepted from
//        the request body)
//     -> the use case (source of truth) -> map the application result to the
//        provider-neutral response contract
// No rate fetching, courier selection, pricing, or financial logic exists here.
//
// The financial contract is preserved and NOT duplicated:
//   - the client NEVER supplies a shipping amount, currency, courier, service
//     code, or request token. Quotes return ONLY the provider-neutral public
//     projection (id, serviceLevel, amountMinor, currency, etaDays); the
//     selection request carries ONLY the application quote id. The authoritative
//     financial + provider selection values are resolved SERVER-SIDE from the
//     quote list persisted on the cart at retrieval time.
//   - selecting a quote that is stale (the cart changed since quotes were
//     fetched) or not in the latest rate response is rejected (INVALID_STATE).
//   - ownership is enforced by the use cases (PERMISSION_DENIED for a foreign
//     cart); an optional bearer token only narrows that check.
//
// Response contract:
//   POST shipping-quotes   200  PublicShippingQuote[] (capped at 50)
//   POST shipping-options  200  { quoteId, serviceLevel, amountMinor, currency, etaDays }
//   400  VALIDATION_ERROR / INVALID_INPUT (malformed body / unknown fields)
//   401  UNAUTHORIZED_ACCESS (invalid, expired, or malformed bearer token)
//   403  PERMISSION_DENIED (authenticated customer does not own the cart)
//   404  CART_NOT_FOUND
//   409  INVALID_OPERATION / INVALID_STATE (no shipping address, cart frozen,
//        already initialized/paid/converted, stale or unknown quote)
//   500  EXTERNAL_SERVICE_* / INTERNAL_ERROR
//
// Security: bearer tokens, secret keys, and internal stack traces are never
// logged and never echoed into responses.

import express from "express";
import type { Request, Response } from "express";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type { RetrieveDynamicShippingQuotesUseCase } from "@api/use-cases/checkout/RetrieveDynamicShippingQuotesUseCase";
import type { SelectShippingOptionUseCase } from "@api/use-cases/checkout/SelectShippingOptionUseCase";
import { resolveActorFromBearerToken } from "../middleware/auth";
import { assertEmptyRequestBody, parseStrictBodyObject, readRequiredPathId } from "../middleware/body";
import {
  createBodyParseErrorHandler,
  mapDomainErrorToHttp,
  sendErrorResponse,
} from "../errors";

const SHIPPING_BODY_LIMIT = "100kb";
const SELECT_OPTION_BODY_KEYS = ["quoteId"] as const;

export interface CheckoutShippingRouterDeps {
  /**
   * Present only when a logistics service is configured. When absent the
   * shipping-quotes route is not registered (requests receive a 404); it is
   * never faked.
   */
  retrieveDynamicShippingQuotes?: RetrieveDynamicShippingQuotesUseCase;
  /** Selection depends only on core dependencies, so it is always wired. */
  selectShippingOption: SelectShippingOptionUseCase;
  /** Verifies the optional bearer JWT (POST /store/auth) into the actor identity. */
  tokenService: ITokenService;
  logger: ILogger;
}

export function createCheckoutShippingRouter(
  deps: CheckoutShippingRouterDeps,
): express.Router {
  const router = express.Router();

  // POST /:id/shipping-quotes — fetch + persist the server-validated quote list.
  if (deps.retrieveDynamicShippingQuotes) {
    router.post(
      "/:id/shipping-quotes",
      express.json({ limit: SHIPPING_BODY_LIMIT }),
      async (req: Request, res: Response) => {
        try {
          const cartId = readRequiredPathId(req.params.id, "cartId");

          // The quotes request carries NO body contract. A payload is rejected
          // outright (strict validation) rather than silently ignored.
          assertEmptyRequestBody(req.body, "shipping-quotes");

          const actorId = await resolveActorFromBearerToken(
            req,
            deps.tokenService,
          );

          const quotes =
            await deps.retrieveDynamicShippingQuotes!.execute({
              cartId,
              actorId,
            });

          res.status(200).json(quotes);
        } catch (err: unknown) {
          const mapped = mapDomainErrorToHttp(err);
          deps.logger.warn("Shipping quotes request rejected", {
            status: mapped.status,
            code: mapped.code,
            cartId: req.params.id,
          });
          sendErrorResponse(res, mapped);
        }
      },
    );
  }

  // POST /:id/shipping-options — select a server-persisted quote for the cart.
  router.post(
    "/:id/shipping-options",
    express.json({ limit: SHIPPING_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const cartId = readRequiredPathId(req.params.id, "cartId");

        // Body: ONLY the client-selectable application quote id. Financial
        // values (amountMinor, currency) and provider selection data
        // (courierId, serviceCode, requestToken) are rejected outright.
        const quoteId = parseStrictBodyObject(
          req.body,
          SELECT_OPTION_BODY_KEYS,
          ["quoteId"],
        ).quoteId as string;

        const actorId = await resolveActorFromBearerToken(
          req,
          deps.tokenService,
        );

        const result = await deps.selectShippingOption.execute({
          cartId,
          quoteId,
          actorId,
        });

        res.status(200).json({
          quoteId: result.quoteId,
          serviceLevel: result.serviceLevel ?? null,
          amountMinor: result.amountMinor,
          currency: result.currency ?? null,
          etaDays: result.etaDays ?? null,
        });
      } catch (err: unknown) {
        const mapped = mapDomainErrorToHttp(err);
        deps.logger.warn("Shipping option selection rejected", {
          status: mapped.status,
          code: mapped.code,
          cartId: req.params.id,
        });
        sendErrorResponse(res, mapped);
      }
    },
  );

  // express.json errors (malformed body, oversized payload) never reach the
  // route handler; map them to the standard envelope.
  router.use(createBodyParseErrorHandler(deps.logger, "Checkout shipping"));

  return router;
}
