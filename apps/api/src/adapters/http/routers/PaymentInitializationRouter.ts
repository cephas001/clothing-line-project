// apps/api/src/adapters/http/routers/PaymentInitializationRouter.ts

// HTTP adapter for the payment-intent endpoint (POST /store/carts/:id/payment-sessions).
//
// The endpoint is the TRANSPORT BOUNDARY ONLY. It performs, in order:
//   HTTP request
//     -> validate/map input (path cartId + optional body { returnUrl })
//     -> resolve the authenticated actor from the bearer JWT when presented
//        (guest checkout remains supported; a customerId is NEVER accepted from
//        the request body)
//     -> InitializePaymentSessionUseCase.execute()
//     -> map the application result to the PaymentSessionResponse contract
// No checkout, pricing, tax, currency, or gateway logic exists here.
//
// The Phase 1 financial contract is preserved and NOT duplicated:
//   - the client never supplies a total, discount, currency, or reference
//   - the use case derives the authoritative amount from durable server state
//     and claims the durable obligation (initialization_pending) before the
//     gateway is contacted
//   - a repeated request reuses the SAME deterministic reference via the use
//     case's idempotent replay; this controller can never create a second
//     financial obligation
//   - gateway failures surface as application-level errors (500) and leave the
//     obligation initialization_pending so a retry re-initializes with the same
//     reference; obligations are never deleted here
//
// This endpoint NEVER finalizes an order, captures a payment, or accepts a
// client-supplied payment status — asynchronous confirmation stays exclusively
// in the webhook -> queue -> PaymentEventWorker flow.
//
// Errors flow through the canonical pipeline (../errors.ts) — the single
// code->status table — so this endpoint can never drift from the rest of the
// boundary.
//
// Response contract (matches PaymentSessionResponse):
//   200  { authorizationUrl, reference }
//   400  VALIDATION_ERROR (malformed body / unknown fields / wrong types)
//   401  UNAUTHORIZED_ACCESS (invalid, expired, or malformed bearer token)
//   403  PERMISSION_DENIED (authenticated customer does not own the cart)
//   404  CART_NOT_FOUND / REGION_NOT_FOUND
//   409  INVALID_OPERATION / INVALID_STATE (empty/fully discounted cart, no
//        shipping selected, stale/inconsistent shipping quote, shipping currency
//        mismatch, already initialized, already paid, already converted,
//        settled obligation, missing email)
//   500  EXTERNAL_SERVICE_* / INTERNAL_ERROR (application-level; the durable
//        obligation stays intact for idempotent retry)
//
// Security: bearer tokens, secret keys, and internal stack traces are never
// logged and never echoed into responses.

import express from "express";
import type { Request, Response } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type { InitializePaymentSessionUseCase } from "@api/use-cases/checkout/InitializePaymentSessionUseCase";
import {
  mapDomainErrorToHttp,
  sendErrorResponse,
  createBodyParseErrorHandler,
} from "../errors";
import { resolveActorFromBearerToken } from "../middleware/auth";

const INIT_BODY_LIMIT = "100kb";
const ALLOWED_BODY_KEYS = ["returnUrl"] as const;

export interface PaymentInitializationRouterDeps {
  /** The use case remains the source of truth for all checkout/pricing logic. */
  initializePaymentSession: InitializePaymentSessionUseCase;
  /** Verifies the optional bearer JWT (POST /store/auth) into the actor identity. */
  tokenService: ITokenService;
  logger: ILogger;
}

export function createPaymentInitializationRouter(
  deps: PaymentInitializationRouterDeps,
): express.Router {
  const router = express.Router();

  router.post(
    "/:id/payment-sessions",
    express.json({ limit: INIT_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        // 1. Path input: cartId. The cart is the resource; the customer can
        //    never be chosen by the client.
        const rawCartId = req.params.id;
        const cartId =
          typeof rawCartId === "string" ? rawCartId.trim() : "";
        if (!cartId) {
          throw new DomainError("VALIDATION_ERROR", "cartId is required.");
        }

        // 2. Body: ONLY client-selectable checkout information. Financial
        //    values, customerId, and payment status are rejected outright.
        const returnUrl = parseInitRequestBody(req.body);

        // 3. Identity: derive the actor from the bearer JWT when presented.
        //    Never from the body.
        const actorId = await resolveActorFromBearerToken(req, deps.tokenService);

        // 4. Use case (source of truth). Idempotent: a repeated request reuses
        //    the same deterministic reference and returns the same result.
        const result = await deps.initializePaymentSession.execute({
          cartId,
          actorId,
          returnUrl,
        });

        // 5. Application-level response only.
        res.status(200).json({
          authorizationUrl: result.authorizationUrl,
          reference: result.reference,
        });
      } catch (err: unknown) {
        const mapped = mapDomainErrorToHttp(err);
        deps.logger.warn("Payment initialization rejected", {
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
  router.use(createBodyParseErrorHandler(deps.logger, "Payment initialization"));

  return router;
}

/**
 * Validate the request body against the strict PaymentSessionRequest contract
 * (only `returnUrl`, `additionalProperties: false`). Returns the normalized
 * returnUrl (or undefined) and throws VALIDATION_ERROR on malformed input.
 */
function parseInitRequestBody(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined; // requestBody is optional
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Request body must be a JSON object.",
    );
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ALLOWED_BODY_KEYS as readonly string[]).includes(key)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Unexpected field "${key}" in request body.`,
      );
    }
  }
  const returnUrlValue = record.returnUrl;
  if (returnUrlValue === undefined || returnUrlValue === null) {
    return undefined;
  }
  if (typeof returnUrlValue !== "string" || returnUrlValue.trim().length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "returnUrl must be a non-empty string when provided.",
    );
  }
  return returnUrlValue.trim();
}
