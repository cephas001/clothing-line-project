// apps/api/src/adapters/http/ShipbubbleWebhookRouter.ts

// HTTP adapter for the Shipbubble logistics webhook endpoint
// (/store/webhooks/shipbubble).
//
// Pipeline (pure orchestration — NO business logic, NO fulfillment mutation,
// NO Shipbubble API calls, NO database work):
//   HTTP request
//     -> raw body captured as bytes (express.raw; the EXACT bytes are what the
//        signature covers — the route is NOT behind global express.json())
//     -> signature verified via VerifyLogisticsEventSignatureUseCase against
//        the raw bytes BEFORE any JSON parsing (HMAC-SHA512 with the dedicated
//        Shipbubble webhook secret — never the API key)
//     -> provider payload validated + mapped to a provider-neutral
//        ProviderLogisticsEvent by the ShipbubbleWebhookPayloadMapper (the ONLY
//        module that knows Shipbubble's event shape; a pure boundary
//        transformation — no repository lookups, no financial checks, no
//        fulfillment mutations)
//     -> QueueLogisticsEventUseCase enqueues the provider-neutral event to the
//        logistics-events-queue (jobId = deterministic eventKey)
//     -> HTTP 200 acknowledgment.
//
// The router NEVER opens a PostgreSQL transaction, and the webhook HTTP request
// holds NO database transaction open while interacting with BullMQ. All
// fulfillment/tracking reconciliation happens LATER in the logistics worker
// (apps/worker) against durable state.
//
// Response contract:
//   200  {"status": "ok", "handled": true} — acknowledged; the provider stops
//        retrying.
//   400  malformed payload (invalid JSON, missing fields) — permanent; the
//        provider should not retry.
//   401  signature mismatch — the event is discarded; the provider retries.
//   413  body too large.
//   500  internal error (queue outage, etc.) — the provider retries.
//
// Security: the raw body, the signature, and the secret are never logged and
// never echoed into responses.

import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { VerifyLogisticsEventSignatureUseCase } from "@api/use-cases/logistics/VerifyLogisticsEventSignatureUseCase";
import type { QueueLogisticsEventUseCase } from "@api/use-cases/logistics/QueueLogisticsEventUseCase";
import type { ShipbubbleWebhookPayloadMapper } from "@api/infrastructure/services/ShipbubbleWebhookPayloadMapper";

const WEBHOOK_BODY_LIMIT = "1mb";
const SIGNATURE_HEADER = "x-shipbubble-signature";

export interface ShipbubbleWebhookRouterDeps {
  /** Provider-agnostic signature verification (secret supplied per request). */
  verifySignature: VerifyLogisticsEventSignatureUseCase;
  /** Enqueues the mapped provider-neutral event for the background worker. */
  queueLogisticsEvent: QueueLogisticsEventUseCase;
  /** Provider-specific payload validator/mapper (pure boundary transformation). */
  mapper: ShipbubbleWebhookPayloadMapper;
  /** The dedicated Shipbubble webhook secret. NOT the API key. */
  webhookSecret: string;
  logger: ILogger;
}

export function createShipbubbleWebhookRouter(
  deps: ShipbubbleWebhookRouterDeps,
): express.Router {
  const router = express.Router();

  router.post(
    "/",
    express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const signatureHeader = (req.get(SIGNATURE_HEADER) ?? "").trim();

      try {
        // 1. Signature verification against the raw bytes, BEFORE JSON parsing
        //    (throws LOGISTICS_VERIFICATION_FAILED on mismatch).
        deps.verifySignature.execute({
          rawBody,
          signatureHeader,
          secretKey: deps.webhookSecret,
        });

        // 2. Pure provider-boundary transformation: raw payload -> provider-
        //    neutral event. No repository lookups, no financial checks, no
        //    fulfillment mutations.
        const logisticsEvent = deps.mapper.parseAndMap(rawBody);

        // 3. Enqueue the provider-neutral event; the worker reconciles against
        //    durable fulfillment state later. jobId = deterministic eventKey.
        await deps.queueLogisticsEvent.execute({ logisticsEvent });

        deps.logger.info(
          "Shipbubble webhook accepted for background processing",
          {
            eventKey: logisticsEvent.eventKey,
            providerShipmentId: logisticsEvent.providerShipmentId,
            eventType: logisticsEvent.eventType,
          },
        );
        res.status(200).json({ status: "ok", handled: true });
      } catch (err: unknown) {
        const mapped = mapWebhookError(err);
        deps.logger.warn("Shipbubble webhook rejected", {
          status: mapped.status,
          code: mapped.code,
        });
        res.status(mapped.status).json({
          success: false,
          error: { code: mapped.code, message: mapped.message },
        });
      }
    },
  );

  // body-parser (express.raw) errors — oversized or malformed byte streams —
  // are forwarded to this error handler and never reach the route handler.
  router.use(rawBodyErrorHandler(deps.logger));

  return router;
}

/** Map a thrown error to an HTTP status + StandardError envelope fields. */
function mapWebhookError(err: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (err instanceof DomainError) {
    switch (err.code) {
      case "LOGISTICS_VERIFICATION_FAILED":
      case "INVALID_SIGNATURE":
        return { status: 401, code: err.code, message: err.message };
      case "VALIDATION_ERROR":
      case "INVALID_INPUT":
        return { status: 400, code: err.code, message: err.message };
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

function rawBodyErrorHandler(logger: ILogger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const status = isEntityTooLarge(err) ? 413 : 400;
    logger.warn("Shipbubble webhook body rejected", {
      status,
      bodyError: isEntityTooLarge(err) ? "too_large" : "unparseable",
    });
    res.status(status).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request body.",
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