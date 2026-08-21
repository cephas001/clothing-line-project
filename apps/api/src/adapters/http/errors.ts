// apps/api/src/adapters/http/errors.ts

// Canonical ERROR PIPELINE (Phase 10): DomainError -> HTTP status -> stable
// { success: false, error: { code, message } } body. A single mapping table is
// the source of truth for the HTTP contract, so every router produces the same
// statuses and envelope for the same domain code.
//
// Safety contract:
//   - NEVER leaks stack traces, SQL/provider errors, tokens, API keys, or raw
//     webhook bodies into a response.
//   - An unexpected (non-DomainError) throw becomes a generic 500
//     INTERNAL_ERROR; the full cause is logged server-side only.
//   - body-parser failures (malformed JSON / oversized payload) are mapped to
//     the envelope as VALIDATION_ERROR (400/413).

import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";

export interface HttpErrorMapping {
  status: number;
  code: string;
  message: string;
}

/**
 * Stable ErrorCode -> HTTP status mapping. Unknown DomainError codes fall back
 * to 500 (the code/message are still surfaced; the code is a stable domain
 * code, never a raw error). Update the union in DomainError.ts AND this table
 * together when adding a code.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  // --- 400 Bad Request: malformed input, unsupported request ----------------
  VALIDATION_ERROR: 400,
  INVALID_INPUT: 400,
  INVALID_EMAIL: 400,
  NEGATIVE_AMOUNT: 400,
  INVALID_CURRENCY: 400,
  INVALID_RETURN_QUANTITY: 400,
  INVALID_RETURN_ITEM: 400,
  INVALID_PAYMENT_AMOUNT: 400,
  UNSUPPORTED_OPERATION: 400,

  // --- 401 Unauthenticated: no/invalid credentials or token -----------------
  // Signature-verification failures are treated as unauthenticated at the
  // webhook boundary: a provider whose signature does not verify must be told
  // the request was not accepted (and should retry with the correct signature),
  // never an opaque 500. The same table serves every webhook router.
  UNAUTHORIZED: 401,
  UNAUTHORIZED_ACCESS: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_SIGNATURE: 401,
  PAYMENT_VERIFICATION_FAILED: 401,
  LOGISTICS_VERIFICATION_FAILED: 401,

  // --- 402 Payment Required -------------------------------------------------
  PAYMENT_REQUIRED: 402,

  // --- 403 Forbidden: authenticated but not allowed -------------------------
  PERMISSION_DENIED: 403,
  UNAUTHORIZED_REVIEW: 403,
  ACCOUNT_DISABLED: 403,
  COMPLIANCE_VIOLATION: 403,

  // --- 404 Not Found --------------------------------------------------------
  RESOURCE_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  CART_NOT_FOUND: 404,
  REGION_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  LOGISTICS_EVENT_FULFILLMENT_NOT_FOUND: 404,

  // --- 409 Conflict: state/rule violation -----------------------------------
  INVALID_OPERATION: 409,
  INVALID_STATE: 409,
  INVALID_STATUS_TRANSITION: 409,
  OUT_OF_STOCK: 409,
  DUPLICATE_TRANSACTION: 409,
  DUPLICATE_QUOTE: 409,
  DUPLICATE_DRAFT_ORDER: 409,
  CUSTOMER_ALREADY_EXISTS: 409,
  BUSINESS_UNIT_ALREADY_EXISTS: 409,
  ORDER_ALREADY_FULFILLED: 409,
  PAYMENT_DECLINED: 409,
  INSUFFICIENT_INVENTORY: 409,
  INSUFFICIENT_SINGLE_LOCATION_STOCK: 409,
  REGIONAL_PRICE_MISSING: 409,
  REFUND_REQUIRES_REVIEW: 409,

  // --- 423 Locked -----------------------------------------------------------
  ACCOUNT_LOCKED: 423,

  // --- 500 Internal / external dependency failure ---------------------------
  INTERNAL_ERROR: 500,
  EXTERNAL_SERVICE_TIMEOUT: 500,
  EXTERNAL_SERVICE_UNAVAILABLE: 500,
  EXTERNAL_SERVICE_ERROR: 500,
  LOCK_ACQUISITION_FAILED: 500,
  JOB_PROCESSING_ERROR: 500,
  SOURCING_FAILED: 500,
  SHIPMENT_REQUIRES_RECONCILIATION: 500,
};

export function mapDomainErrorToHttp(err: unknown): HttpErrorMapping {
  if (err instanceof DomainError) {
    const status = STATUS_BY_CODE[err.code] ?? 500;
    return { status, code: err.code, message: err.message };
  }
  // Unknown/unexpected error: NEVER echo the cause. Generic 500 only.
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Internal server error.",
  };
}

/** Write the canonical error envelope. */
export function sendErrorResponse(
  res: Response,
  mapping: HttpErrorMapping,
): void {
  res.status(mapping.status).json({
    success: false,
    error: { code: mapping.code, message: mapping.message },
  });
}

type BodyParseKind = "too_large" | "unparseable" | null;

/** Detect a body-parser failure (malformed JSON, oversized/encoding errors). */
function classifyBodyParseError(err: unknown): BodyParseKind {
  if (typeof err !== "object" || err === null) {
    return null;
  }
  const type = (err as { type?: unknown }).type;
  if (type === "entity.too.large") {
    return "too_large";
  }
  if (
    type === "entity.parse.failed" ||
    type === "entity.verify.failed" ||
    type === "entity.encoding.unsupported" ||
    type === "request.aborted" ||
    err instanceof SyntaxError
  ) {
    return "unparseable";
  }
  return null;
}

/**
 * Router-level handler for per-route body parsers (e.g. express.json mounted
 * inside a router). Maps malformed/oversized payloads to the standard envelope.
 */
export function createBodyParseErrorHandler(
  logger: ILogger,
  context: string,
): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const kind = classifyBodyParseError(err);
    const status = kind === "too_large" ? 413 : 400;
    logger.warn(`${context} request body rejected`, {
      status,
      bodyError: kind ?? "unparseable",
    });
    sendErrorResponse(res, {
      status,
      code: "VALIDATION_ERROR",
      message:
        status === 413
          ? "Request body too large."
          : "Request body is not valid JSON.",
    });
  };
}

/**
 * Terminal JSON 404 for unmatched routes. Keeps every response on the same
 * envelope instead of the Express HTML fallback.
 */
export function createNotFoundHandler(logger: ILogger): RequestHandler {
  return (req, res) => {
    logger.warn("Unmatched route", {
      method: req.method,
      path: req.originalUrl,
    });
    sendErrorResponse(res, {
      status: 404,
      code: "RESOURCE_NOT_FOUND",
      message: "The requested endpoint was not found.",
    });
  };
}

/**
 * Terminal error handler (must be mounted LAST). Catches any error that
 * reaches the app edge: DomainErrors are mapped, body-parser failures become
 * VALIDATION_ERROR, and anything else is logged server-side (full cause) and
 * answered with a generic 500 — never the raw error.
 */
export function createTerminalErrorHandler(logger: ILogger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const bodyKind = classifyBodyParseError(err);
    if (bodyKind) {
      const status = bodyKind === "too_large" ? 413 : 400;
      logger.warn("Request body rejected", {
        status,
        bodyError: bodyKind,
        method: req.method,
        path: req.originalUrl,
      });
      sendErrorResponse(res, {
        status,
        code: "VALIDATION_ERROR",
        message:
          status === 413
            ? "Request body too large."
            : "Request body is not valid JSON.",
      });
      return;
    }
    const mapped = mapDomainErrorToHttp(err);
    if (mapped.status >= 500) {
      // Unexpected/unhandled failure: log the full cause server-side, never
      // echo stack traces, SQL, provider bodies, tokens, or API keys.
      logger.error("Unhandled request error", {
        err,
        method: req.method,
        path: req.originalUrl,
        code: mapped.code,
      });
    } else {
      logger.warn("Request rejected", {
        status: mapped.status,
        code: mapped.code,
        method: req.method,
        path: req.originalUrl,
      });
    }
    sendErrorResponse(res, mapped);
  };
}
