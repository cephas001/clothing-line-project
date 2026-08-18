// apps/api/src/adapters/http/routers/PaymentWebhookRouter.ts

// HTTP adapter for the payment-gateway webhook endpoint (/store/payments/webhook).
//
// Pipeline (pure orchestration — NO business logic, NO synchronous finalization):
//   HTTP request
//     -> raw body captured as bytes (express.raw; the EXACT bytes are what the
//        signature covers)
//     -> signature verified via VerifyPaymentEventSignatureUseCase against the
//        `x-paystack-signature` header (HMAC-SHA512 with the dedicated webhook
//        secret — never the API secret key)
//     -> provider payload validated + mapped to an internal event by the
//        PaystackWebhookPayloadMapper (the ONLY module that knows Paystack's
//        event shape); the mapper resolves the LOCAL durable obligation by
//        reference and rejects an already-evident currency mismatch
//     -> QueuePaymentEventUseCase enqueues the provider-agnostic event
//     -> HTTP 200 acknowledgment. The order is finalized LATER by the
//        PaymentEventWorker (apps/worker), never from this request.
//
// A valid signature is NOT sufficient for financial correctness. The worker
// runs VerifyPaymentEventUseCase against the DURABLE payment obligation
// (reference, context, amount, currency, state — PostgreSQL authoritative)
// BEFORE FinalizeOrderTransactionUseCase. This router only rejects what is
// already provably wrong here (malformed payload, currency mismatch), so the
// gateway stops retrying permanent failures.
//
// Response contract:
//   200  acknowledged (handled: true = enqueued, false = acknowledged but not
//        applicable) — the gateway stops retrying.
//   400  malformed payload or permanent financial mismatch (currency/amount);
//        the gateway should not retry.
//   401  signature mismatch — the event is discarded and the gateway retries.
//   413  body too large.
//   500  internal error (queue outage, etc.) — the gateway retries.
//
// Security: the raw body, the signature, and the secret are never logged and
// never echoed into responses.

import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { VerifyPaymentEventSignatureUseCase } from "@api/use-cases/checkout/VerifyPaymentEventSignatureUseCase";
import type { QueuePaymentEventUseCase } from "@api/use-cases/checkout/QueuePaymentEventUseCase";
import type { PaystackWebhookPayloadMapper } from "@api/infrastructure/services/PaystackWebhookPayloadMapper";

const WEBHOOK_BODY_LIMIT = "1mb";
const SIGNATURE_HEADER = "x-paystack-signature";

export interface PaymentWebhookRouterDeps {
  /** Provider-agnostic signature verification (secret supplied per request). */
  verifySignature: VerifyPaymentEventSignatureUseCase;
  /** Enqueues the mapped payment event for the background worker. */
  queuePaymentEvent: QueuePaymentEventUseCase;
  /** Provider-specific payload validator/mapper. */
  mapper: PaystackWebhookPayloadMapper;
  /** The dedicated Paystack webhook secret. NOT the API secret key. */
  webhookSecret: string;
  logger: ILogger;
}

export function createPaymentWebhookRouter(
  deps: PaymentWebhookRouterDeps,
): express.Router {
  const router = express.Router();

  router.post(
    "/",
    express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
    async (req: Request, res: Response) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const signatureHeader = (req.get(SIGNATURE_HEADER) ?? "").trim();

      try {
        // 1. Signature verification against the raw bytes (throws on mismatch).
        deps.verifySignature.execute({
          rawBody,
          signatureHeader,
          secretKey: deps.webhookSecret,
        });

        // 2. Provider payload validation + provider-to-internal mapping. The
        //    mapper resolves the local payment obligation by reference and
        //    produces the typed internal PaymentEventJobPayload (never a raw
        //    provider envelope).
        const result = await deps.mapper.parseAndMap(rawBody);

        // 3. Well-formed but not applicable (other event types / no resolvable
        //    checkout obligation): acknowledge so the gateway stops retrying,
        //    without producing queue noise.
        if (!result.handled) {
          deps.logger.info(
            "Payment webhook acknowledged (not applicable)",
            { eventType: result.eventType },
          );
          res.status(200).json({ status: "ok", handled: false });
          return;
        }

        // 4. Enqueue the provider-agnostic event; the worker finalizes later.
        await deps.queuePaymentEvent.execute({
          paymentEvent: result.paymentEvent,
        });

        deps.logger.info(
          "Payment webhook accepted for background processing",
          { transactionReference: result.paymentEvent.transactionReference },
        );
        res.status(200).json({ status: "ok", handled: true });
      } catch (err: unknown) {
        const mapped = mapWebhookError(err);
        deps.logger.warn("Payment webhook rejected", {
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
      case "PAYMENT_VERIFICATION_FAILED":
        return { status: 401, code: err.code, message: err.message };
      case "VALIDATION_ERROR":
      case "INVALID_INPUT":
      case "INVALID_CURRENCY":
      case "INVALID_PAYMENT_AMOUNT":
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
    logger.warn("Payment webhook body rejected", {
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
