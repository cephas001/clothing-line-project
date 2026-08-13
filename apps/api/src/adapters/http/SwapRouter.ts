// apps/api/src/adapters/http/SwapRouter.ts

// HTTP adapter for the swap-payment endpoint (POST /store/orders/:orderId/swaps).
//
// The endpoint is the TRANSPORT BOUNDARY ONLY. It performs, in order:
//   HTTP request
//     -> validate/map input (path orderId + body { returnLineItemId,
//        returnQuantity, newVariantId, paymentRedirectBaseUrl? })
//     -> resolve the authenticated actor from the bearer JWT when presented
//        (never from the request body)
//     -> ProcessOrderSwapVarianceUseCase.execute()
//     -> map the application result to the SwapResponse contract
// No pricing, tax, currency, refund, or gateway logic exists here.
//
// The Phase 3 financial contract is preserved and NOT duplicated:
//   - the client NEVER supplies a financial value. The replacement price is
//     resolved server-side from the authoritative regional price and the
//     variance is denominated in the order's FROZEN currency; `newVariantPriceMinor`
//     is deliberately absent from the request contract. Unknown fields are
//     rejected (strict validation).
//   - when the customer owes money, the exact server-calculated amount/currency
//     becomes a DURABLE payment obligation BEFORE Paystack is contacted; a
//     repeated request reuses the SAME deterministic reference via the use
//     case's idempotent replay, so this controller can never create a second
//     financial obligation or a second gateway charge.
//   - gateway failures surface as application-level errors (500) and leave the
//     obligation initialization_pending so a retry re-initializes with the same
//     reference; obligations are never deleted here.
//
// This endpoint NEVER finalizes a swap or captures a payment — asynchronous
// confirmation stays exclusively in the webhook -> queue -> PaymentEventWorker
// flow (VerifySwapPaymentEventUseCase then FinalizeSwapTransactionUseCase).
//
// Response contract (matches SwapResponse):
//   201  { swapId, variance, action, paymentUrl }
//   400  VALIDATION_ERROR / INVALID_INPUT / INVALID_RETURN_QUANTITY
//   401  UNAUTHORIZED_ACCESS (invalid, expired, or malformed bearer token)
//   403  PERMISSION_DENIED (authenticated customer does not own the order)
//   404  RESOURCE_NOT_FOUND (order / customer)
//   409  INVALID_OPERATION / REGIONAL_PRICE_MISSING / REFUND_REQUIRES_REVIEW
//   500  EXTERNAL_SERVICE_* / INTERNAL_ERROR (application-level; the durable
//        obligation stays intact for idempotent retry)
//
// Security: bearer tokens, secret keys, and internal stack traces are never
// logged and never echoed into responses.

import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type { ProcessOrderSwapVarianceUseCase } from "@api/use-cases/logistics/ProcessOrderSwapVarianceUseCase";

const SWAP_BODY_LIMIT = "100kb";
const ALLOWED_BODY_KEYS = [
  "returnLineItemId",
  "returnQuantity",
  "newVariantId",
  "paymentRedirectBaseUrl",
] as const;

export interface SwapRouterDeps {
  /** The use case remains the source of truth for all swap/pricing logic. */
  processOrderSwapVariance: ProcessOrderSwapVarianceUseCase;
  /** Verifies the optional bearer JWT (POST /store/auth) into the actor identity. */
  tokenService: ITokenService;
  logger: ILogger;
}

export function createSwapRouter(deps: SwapRouterDeps): express.Router {
  const router = express.Router();

  router.post(
    "/:orderId/swaps",
    express.json({ limit: SWAP_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        // 1. Path input: orderId. The order is the resource; the customer can
        //    never be chosen by the client.
        const rawOrderId = req.params.orderId;
        const orderId =
          typeof rawOrderId === "string" ? rawOrderId.trim() : "";
        if (!orderId) {
          throw new DomainError("VALIDATION_ERROR", "orderId is required.");
        }

        // 2. Body: ONLY client-selectable swap identifiers. Financial values
        //    (amountMinor, currency, replacement price) are rejected outright.
        const body = parseSwapRequestBody(req.body);

        // 3. Identity: derive the actor from the bearer JWT when presented.
        //    Never from the body.
        const actorId = await resolveActorFromBearerToken(req, deps.tokenService);

        // 4. Use case (source of truth). Idempotent: a repeated request reuses
        //    the same deterministic swap/payment/refund references.
        const result = await deps.processOrderSwapVariance.execute({
          orderId,
          returnLineItemId: body.returnLineItemId,
          returnQuantity: body.returnQuantity,
          newVariantId: body.newVariantId,
          paymentRedirectBaseUrl: body.paymentRedirectBaseUrl,
          actorId,
        });

        // 5. Application-level response only.
        res.status(201).json({
          swapId: result.swapId,
          variance: result.variance,
          action: result.action,
          paymentUrl: result.paymentUrl ?? null,
        });
      } catch (err: unknown) {
        const mapped = mapSwapError(err);
        deps.logger.warn("Swap request rejected", {
          status: mapped.status,
          code: mapped.code,
          orderId: req.params.orderId,
        });
        res.status(mapped.status).json({
          success: false,
          error: { code: mapped.code, message: mapped.message },
        });
      }
    },
  );

  // express.json errors (malformed body, oversized payload) never reach the
  // route handler; map them to the standard envelope.
  router.use(bodyParseErrorHandler(deps.logger));

  return router;
}

/**
 * Validate the request body against the strict SwapRequest contract (only the
 * swap business identifiers + optional redirect URL, `additionalProperties:
 * false`). Financial fields are rejected outright. Returns the normalized body
 * and throws VALIDATION_ERROR on malformed input.
 */
function parseSwapRequestBody(body: unknown): {
  returnLineItemId: string;
  returnQuantity: number;
  newVariantId: string;
  paymentRedirectBaseUrl?: string;
} {
  if (body === undefined || body === null) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Request body is required.",
    );
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

  const returnLineItemIdValue = record.returnLineItemId;
  const returnLineItemId =
    typeof returnLineItemIdValue === "string"
      ? returnLineItemIdValue.trim()
      : "";
  if (!returnLineItemId) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "returnLineItemId is required.",
    );
  }

  const returnQuantity = Number(record.returnQuantity);
  if (
    !Number.isSafeInteger(returnQuantity) ||
    returnQuantity < 1
  ) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "returnQuantity must be a positive integer.",
    );
  }

  const newVariantIdValue = record.newVariantId;
  const newVariantId =
    typeof newVariantIdValue === "string" ? newVariantIdValue.trim() : "";
  if (!newVariantId) {
    throw new DomainError("VALIDATION_ERROR", "newVariantId is required.");
  }

  let paymentRedirectBaseUrl: string | undefined;
  const redirectValue = record.paymentRedirectBaseUrl;
  if (redirectValue !== undefined && redirectValue !== null) {
    if (
      typeof redirectValue !== "string" ||
      redirectValue.trim().length === 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "paymentRedirectBaseUrl must be a non-empty string when provided.",
      );
    }
    paymentRedirectBaseUrl = redirectValue.trim();
  }

  return { returnLineItemId, returnQuantity, newVariantId, paymentRedirectBaseUrl };
}

/**
 * Resolve the authenticated actor from the `Authorization: Bearer <jwt>` header.
 * Returns undefined when no header is presented. Throws UNAUTHORIZED_ACCESS for
 * a present-but-invalid header or token. A customerId is never read from the
 * request body.
 */
async function resolveActorFromBearerToken(
  req: Request,
  tokenService: ITokenService,
): Promise<string | undefined> {
  const authHeader = (req.get("authorization") ?? "").trim();
  if (!authHeader) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = match?.[1]?.trim() ?? "";
  if (!match || !token) {
    throw new DomainError(
      "UNAUTHORIZED_ACCESS",
      "Authorization header must use the 'Bearer <token>' scheme.",
    );
  }
  try {
    const claims = await tokenService.verifyToken(token);
    const customerId =
      typeof claims.customerId === "string" ? claims.customerId.trim() : "";
    if (!customerId) {
      throw new DomainError(
        "UNAUTHORIZED_ACCESS",
        "Authentication token carries no customer identity.",
      );
    }
    return customerId;
  } catch (err: unknown) {
    if (err instanceof DomainError) {
      throw err;
    }
    throw new DomainError(
      "UNAUTHORIZED_ACCESS",
      "Invalid or expired authentication token.",
    );
  }
}

/**
 * Map a thrown error to the standard error envelope. External infrastructure
 * failures (gateway timeouts, unavailability, DB errors) surface as
 * application-level 500s — never as raw provider errors — and the durable
 * obligation is left untouched for idempotent retry.
 */
function mapSwapError(err: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (err instanceof DomainError) {
    switch (err.code) {
      case "VALIDATION_ERROR":
      case "INVALID_INPUT":
      case "INVALID_RETURN_QUANTITY":
        return { status: 400, code: err.code, message: err.message };
      case "UNAUTHORIZED_ACCESS":
        return { status: 401, code: err.code, message: err.message };
      case "PERMISSION_DENIED":
        // Authenticated but the order belongs to a different customer.
        return { status: 403, code: err.code, message: err.message };
      case "RESOURCE_NOT_FOUND":
        return { status: 404, code: err.code, message: err.message };
      case "INVALID_OPERATION":
      case "REGIONAL_PRICE_MISSING":
      case "REFUND_REQUIRES_REVIEW":
        // Conflict: the swap cannot be priced/completed with the current
        // state (missing region/currency/customer/email, unsettled obligation,
        // ambiguous refund). The client should not blindly retry.
        return { status: 409, code: err.code, message: err.message };
      case "EXTERNAL_SERVICE_TIMEOUT":
      case "EXTERNAL_SERVICE_UNAVAILABLE":
      case "EXTERNAL_SERVICE_ERROR":
      case "INTERNAL_ERROR":
        return { status: 500, code: err.code, message: err.message };
      default:
        return { status: 500, code: err.code, message: err.message };
    }
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Internal server error.",
  };
}

function bodyParseErrorHandler(logger: ILogger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const status = isEntityTooLarge(err) ? 413 : 400;
    logger.warn("Swap request body rejected", {
      status,
      bodyError: isEntityTooLarge(err) ? "too_large" : "unparseable",
    });
    res.status(status).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: isEntityTooLarge(err)
          ? "Request body too large."
          : "Request body is not valid JSON.",
      },
    });
  };
}

function isEntityTooLarge(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "entity.too.large"
  );
}