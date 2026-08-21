// apps/api/src/infrastructure/services/CourierTrackingWebhookPayloadMapper.ts

// Provider-specific adapter that translates an incoming courier-tracking webhook
// POST (the OpenAPI `CourierTrackingWebhook` body consumed by
// /store/webhooks/courier-tracking) into the provider-neutral
// `ProviderLogisticsEvent` the domain/queue contract expects. This is the
// explicit mapping function at the application/infrastructure boundary: it is
// the ONLY module that knows the courier-tracking webhook's event shape, and no
// courier-tracking structure ever reaches the queue contract or the worker.
//
// Responsibilities:
// - map: validate the parsed request body and map it to a `ProviderLogisticsEvent`.
// - Extract the courier status (raw values pass through; the schema vocabulary
//   is in_transit | out_for_delivery | delivered | failed_attempt), the tracking
//   number (the courier's ONLY cross-boundary identity — this payload carries NO
//   provider shipment id), the event timestamp, and the notifyCustomer flag.
// - Derive the deterministic `eventKey` (L5 PART 6 idempotency): the job id of
//   the enqueued job. The payload carries NO provider event id, so the key is
//   derived from STABLE provider fields:
//       "courier:<trackingNumber>:tracking.status_changed:<status>:<occurredAt>"
//   The ISO timestamp is the OCCURRENCE DISCRIMINATOR only — it distinguishes
//   multiple scans of the same shipment + status (two in_transit scans are two
//   logical events) — and is never used alone. A missing timestamp is a
//   structural failure (the payload then offers no way to tell one event from
//   the next) and is rejected permanently.
// - STRICTLY a pure provider-boundary transformation: it does NOT look up
//   PostgreSQL records, does NOT decide whether an event is financially valid,
//   and does NOT mutate fulfillment. It only validates and maps the payload.
//
// Structurally malformed payloads (missing tracking number, missing status,
// missing/invalid timestamp) THROW a VALIDATION_ERROR DomainError, which the
// router maps to HTTP 400 (a permanent failure the courier should not retry).
//
// Mapping rules (provider -> internal):
//   trackingNumber           -> providerShipmentId AND trackingNumber (the
//                               tracking number IS the courier's only identity;
//                               the worker reconciles by it)
//   courierStatus            -> status (trimmed; unknown values pass through)
//   "tracking.status_changed"-> eventType (the payload conveys only courier status)
//   timestamp                -> occurredAt (validated ISO date + the eventKey
//                               occurrence discriminator)
//   notifyCustomer (default true) -> notifyCustomer

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { ProviderLogisticsEvent } from "@api/domain/shared/contracts";

const COURIER_TRACKING_EVENT_TYPE = "tracking.status_changed";

export class CourierTrackingWebhookPayloadMapper {
  /**
   * Parse and map a signature-verified raw webhook body to a provider-neutral
   * `ProviderLogisticsEvent`. Throws VALIDATION_ERROR for structurally invalid
   * payloads. Never touches PostgreSQL and never mutates fulfillment.
   */
  parseAndMap(rawBody: Buffer): ProviderLogisticsEvent {
    return this.map(parseJsonEnvelope(rawBody));
  }

  /**
   * Map a parsed courier-tracking webhook body to a provider-neutral
   * `ProviderLogisticsEvent`. Throws VALIDATION_ERROR for structurally invalid
   * payloads. Never touches PostgreSQL and never mutates fulfillment.
   */
  map(payload: unknown): ProviderLogisticsEvent {
    const body = requireObject(payload, "payload");

    const trackingNumber = readRequiredString(body.trackingNumber, "trackingNumber");
    const status = readRequiredString(body.courierStatus, "courierStatus");
    const occurredAt = readTimestamp(body.timestamp);
    const notifyCustomer = readNotifyCustomer(body.notifyCustomer);

    return {
      provider: "courier",
      providerShipmentId: trackingNumber,
      trackingNumber,
      courier: null,
      eventType: COURIER_TRACKING_EVENT_TYPE,
      status,
      occurredAt,
      eventKey: buildEventKey(trackingNumber, status, occurredAt),
      notifyCustomer,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-local validation + mapping helpers (kept private; no courier-tracking
// types leak out of this module)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonEnvelope(rawBody: Buffer): Record<string, unknown> {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Webhook request body is empty.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Webhook payload is not valid JSON.",
    );
  }
  if (!isRecord(parsed)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Webhook payload must be a JSON object.",
    );
  }
  return parsed;
}

function requireObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Webhook payload field '${field}' must be an object.`,
    );
  }
  return value;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Webhook payload field '${field}' is required and must be a non-empty string.`,
    );
  }
  return value.trim();
}

function readTimestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Webhook payload field 'timestamp' is required and must be a valid date string.",
    );
  }
  return value;
}

/** notifyCustomer defaults to true per the OpenAPI contract. */
function readNotifyCustomer(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Webhook payload field 'notifyCustomer' must be a boolean.",
    );
  }
  return value;
}

/**
 * Deterministic, stable identity of ONE logical courier-tracking event (the
 * queue job id). Derived from stable provider fields ONLY — never a random
 * UUID. The ISO timestamp is the occurrence discriminator that distinguishes
 * multiple scans of the same shipment + status (two in_transit scans are two
 * logical events) and is never used alone.
 */
function buildEventKey(
  trackingNumber: string,
  status: string,
  occurredAt: string,
): string {
  return `courier:${trackingNumber}:${COURIER_TRACKING_EVENT_TYPE}:${status}:${occurredAt}`;
}