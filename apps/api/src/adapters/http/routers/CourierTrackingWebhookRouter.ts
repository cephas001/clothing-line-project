// apps/api/src/adapters/http/routers/CourierTrackingWebhookRouter.ts

// HTTP adapter for the generic courier-tracking webhook endpoint
// (/store/webhooks/courier-tracking).
//
// Pipeline (pure orchestration — NO business logic, NO fulfillment mutation,
// NO database work):
//   HTTP request
//     -> raw body captured as bytes (express.raw; the EXACT bytes are what the
//        signature covers — the route is NOT behind global express.json())
//     -> signature verified via VerifyLogisticsEventSignatureUseCase against
//        the raw bytes BEFORE any JSON parsing (HMAC-SHA512 with the dedicated
//        courier-tracking webhook secret — never any API key). A missing or
//        mismatched signature FAILS CLOSED with 401 and the event is discarded.
//     -> payload parsed + validated + mapped to a provider-neutral
//        ProviderLogisticsEvent by the CourierTrackingWebhookPayloadMapper (the
//        ONLY module that knows the courier-tracking webhook's shape; a pure
//        boundary transformation — no repository lookups, no financial checks,
//        no fulfillment mutations)
//     -> QueueLogisticsEventUseCase enqueues the provider-neutral event to the
//        logistics-events-queue (jobId = deterministic eventKey)
//     -> HTTP 204 No Content acknowledgment.
//
// The router NEVER opens a PostgreSQL transaction, and the webhook HTTP request
// holds NO database transaction open while interacting with BullMQ. All
// fulfillment/tracking reconciliation happens LATER in the logistics worker
// (apps/worker) against durable state.
//
// SECURITY: the shared signing secret is provisioned via the
// COURIER_TRACKING_WEBHOOK_SECRET environment variable and the endpoint is only
// mounted when it is present. Signature verification runs over the RAW request
// bytes (HMAC-SHA512, constant-time compare) and happens BEFORE any JSON
// parsing — a malformed or tampered payload never reaches the mapper. The raw
// body, the supplied signature, and the secret are never logged.
//
// Response contract:
//   204  acknowledged — the courier stops retrying.
//   400  malformed payload (missing tracking number / status / timestamp,
//        invalid timestamp, invalid JSON) — permanent; do not retry.
//   401  missing/mismatched signature — the event is discarded; the courier
//        retries.
//   413  body too large.
//   500  internal error (queue outage, etc.) — the courier retries.
//
// Security: raw webhook bodies and internal errors are never logged and never
// echoed into responses.

import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { VerifyLogisticsEventSignatureUseCase } from "@api/use-cases/logistics/VerifyLogisticsEventSignatureUseCase";
import type { QueueLogisticsEventUseCase } from "@api/use-cases/logistics/QueueLogisticsEventUseCase";
import type { CourierTrackingWebhookPayloadMapper } from "@api/infrastructure/services/CourierTrackingWebhookPayloadMapper";
import {
  mapDomainErrorToHttp,
  sendErrorResponse,
} from "../errors";

const WEBHOOK_BODY_LIMIT = "1mb";
const SIGNATURE_HEADER = "x-courier-signature";

export interface CourierTrackingWebhookRouterDeps {
  /** Provider-agnostic signature verification (secret supplied per request). */
  verifySignature: VerifyLogisticsEventSignatureUseCase;
  /** Enqueues the mapped provider-neutral event for the background worker. */
  queueLogisticsEvent: QueueLogisticsEventUseCase;
  /** Provider-specific payload validator/mapper (pure boundary transformation). */
  mapper: CourierTrackingWebhookPayloadMapper;
  /** The dedicated courier-tracking webhook secret. NOT any API key. */
  webhookSecret: string;
  logger: ILogger;
}

export function createCourierTrackingWebhookRouter(
  deps: CourierTrackingWebhookRouterDeps,
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
        //    (throws LOGISTICS_VERIFICATION_FAILED on a missing/mismatched
        //    signature — the event is discarded and the courier retries).
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
          "Courier tracking webhook accepted for background processing",
          {
            eventKey: logisticsEvent.eventKey,
            trackingNumber: logisticsEvent.trackingNumber ?? null,
            status: logisticsEvent.status ?? null,
          },
        );
        res.status(204).end();
      } catch (err: unknown) {
        const mapped = mapDomainErrorToHttp(err);
        deps.logger.warn("Courier tracking webhook rejected", {
          status: mapped.status,
          code: mapped.code,
        });
        sendErrorResponse(res, mapped);
      }
    },
  );

  // body-parser (express.raw) errors — oversized or malformed byte streams —
  // are forwarded to this error handler and never reach the route handler.
  router.use(rawBodyErrorHandler(deps.logger));

  return router;
}

function rawBodyErrorHandler(logger: ILogger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const status = isEntityTooLarge(err) ? 413 : 400;
    logger.warn("Courier tracking webhook body rejected", {
      status,
      bodyError: isEntityTooLarge(err) ? "too_large" : "unparseable",
    });
    sendErrorResponse(res, {
      status,
      code: "VALIDATION_ERROR",
      message: "Invalid request body.",
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