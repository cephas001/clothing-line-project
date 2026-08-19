// apps/api/src/infrastructure/services/ShipbubbleWebhookPayloadMapper.ts

// Provider-specific adapter that translates an incoming Shipbubble webhook POST
// into the provider-neutral `ProviderLogisticsEvent` the domain/queue contract
// expects. This is the explicit mapping function at the
// application/infrastructure boundary: it is the ONLY module that knows
// Shipbubble's webhook event shape, and no Shipbubble structure ever reaches
// the queue contract or the worker.
//
// Responsibilities:
// - parseAndMap: parse the RAW request body (already signature-verified by the
//   router) as JSON and validate the provider envelope.
// - Extract the provider shipment identity (data.order_id, falling back to
//   data.id), the normalized event type, the courier status, and the tracking
//   number.
// - Derive the deterministic `eventKey` (L5 PART 6 idempotency): the job id of
//   the enqueued job. It is derived from STABLE provider fields ONLY:
//     * a provider event id (`envelope.id`, else `data.event_id`) when one
//       exists  -> "shipbubble:<eventId>";
//     * otherwise the stable triple (providerShipmentId, normalized event type,
//       status) -> "shipbubble:<providerShipmentId>:<eventType>:<status>".
//   Never a timestamp alone, never a random UUID, and never providerShipmentId
//   alone (one shipment emits many events).
// - STRICTLY a pure provider-boundary transformation: it does NOT look up
//   PostgreSQL records, does NOT decide whether an event is financially valid,
//   and does NOT mutate fulfillment. It only validates and maps the payload.
//
// Structurally malformed payloads (invalid JSON, missing envelope/data,
// missing provider shipment id, missing event type, invalid date) THROW a
// VALIDATION_ERROR DomainError, which the router maps to HTTP 400 (a permanent
// failure the provider should not retry).
//
// Mapping rules (provider -> internal):
//   data.order_id (else data.id) -> providerShipmentId (the PROVIDER's id,
//                                   never the application orderId)
//   data.tracking_number (else data.courier.tracking_code) -> trackingNumber
//   data.courier (string or .name) -> courier
//   data.status                   -> status (trimmed, lowercased courier
//                                    vocabulary; unknown values pass through)
//   envelope.event (else status)  -> eventType (normalized via
//                                    PROVIDER_LOGISTICS_EVENT_TYPES; anything
//                                    unrecognized maps to "unknown")
//   data.event_time / created_at  -> occurredAt (validated ISO date)

import { DomainError } from "@api/domain/entities/errors/DomainError";
import {
  ProviderLogisticsEvent,
  ProviderLogisticsEventType,
} from "@api/domain/shared/contracts";

export class ShipbubbleWebhookPayloadMapper {
  /**
   * Parse and map a signature-verified raw webhook body to a provider-neutral
   * `ProviderLogisticsEvent`. Throws VALIDATION_ERROR for structurally invalid
   * payloads. Never touches PostgreSQL and never mutates fulfillment.
   */
  parseAndMap(rawBody: Buffer): ProviderLogisticsEvent {
    const envelope = parseJsonEnvelope(rawBody);
    const data = requireObject(envelope.data, "data");

    // --- Provider shipment identity (preferred: order_id, fallback: id) -------
    const providerShipmentId =
      readOptionalString(data.order_id) ?? readOptionalString(data.id);
    if (!providerShipmentId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Shipbubble webhook payload must include a provider shipment id (data.order_id or data.id).",
      );
    }

    // --- Tracking number (data.tracking_number, else courier.tracking_code) ---
    const courier = readCourier(data.courier);
    const trackingNumber =
      readOptionalString(data.tracking_number) ??
      readOptionalString(isRecord(data.courier) ? data.courier.tracking_code : undefined);

    // --- Courier status (normalized to the courier vocabulary) ----------------
    const status = readOptionalString(data.status)?.toLowerCase() ?? null;

    // --- Event type (envelope.event, else derived from status) ----------------
    const eventType = normalizeEventType(
      readOptionalString(envelope.event),
      status,
    );

    // --- Event occurrence time (validated; null when absent) -----------------
    const occurredAt = readOccurredAt(data);

    // --- Event identity + deterministic idempotency key (L5 PART 6) -----------
    const providerEventId =
      readOptionalString(envelope.id) ?? readOptionalString(data.event_id);
    const eventKey = buildEventKey(
      providerEventId,
      providerShipmentId,
      eventType,
      status,
    );

    return {
      provider: "shipbubble",
      providerShipmentId,
      trackingNumber: trackingNumber ?? null,
      courier: courier ?? null,
      eventType,
      status,
      occurredAt,
      eventKey,
      providerEventId: providerEventId ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-local validation + mapping helpers (kept private; no Shipbubble types
// leak out of this module)
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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
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

/** data.courier arrives either as a string name or as { name, tracking_code }. */
function readCourier(value: unknown): string | undefined {
  if (typeof value === "string") {
    const name = value.trim();
    return name.length > 0 ? name : undefined;
  }
  if (isRecord(value)) {
    return readOptionalString(value.name);
  }
  return undefined;
}

/** Event occurrence time: data.event_time, else data.created_at, else null. */
function readOccurredAt(data: Record<string, unknown>): string | null {
  const raw =
    readOptionalString(data.event_time) ??
    readOptionalString(data.created_at) ??
    readOptionalString(data.updated_at);
  if (raw === undefined) {
    return null;
  }
  if (Number.isNaN(Date.parse(raw))) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Shipbubble webhook payload event time must be a valid date string.",
    );
  }
  return raw;
}

/**
 * Map a Shipbubble event name (or the courier status as a fallback) onto the
 * provider-neutral event vocabulary. Shipbubble event names are mapped
 * best-effort from stable keywords; anything unrecognized maps to "unknown" —
 * never a fabricated type, never a silently repurposed one.
 */
function normalizeEventType(
  eventName: string | undefined,
  status: string | null,
): ProviderLogisticsEventType {
  const name = (eventName ?? "").toLowerCase();

  if (name.includes("cancel") || name.includes("cancelled")) {
    return "shipment.cancelled";
  }
  if (name.includes("created")) {
    return "shipment.created";
  }
  if (name.includes("delivered")) {
    return "delivery.completed";
  }
  if (name.includes("delivery") || name.includes("out_for_delivery")) {
    return "delivery.attempted";
  }
  if (name.includes("failed") || name.includes("exception")) {
    return "delivery.exception";
  }
  if (
    name.includes("tracking") ||
    name.includes("status") ||
    name.includes("updated") ||
    name.includes("in_transit")
  ) {
    return "tracking.status_changed";
  }

  // No usable event name: derive from the courier status when present.
  if (status !== null) {
    if (status === "delivered") {
      return "delivery.completed";
    }
    if (status === "out_for_delivery") {
      return "delivery.attempted";
    }
    if (status === "failed_attempt" || status.startsWith("failed")) {
      return "delivery.exception";
    }
    return "tracking.status_changed";
  }

  return "unknown";
}

/**
 * Deterministic, stable identity of ONE logical provider event (the queue job
 * id). Derived from stable provider fields ONLY:
 *   - a provider event id (envelope.id, else data.event_id) -> "shipbubble:<id>";
 *   - otherwise the stable triple (providerShipmentId, eventType, status).
 * Never a timestamp, never a random UUID, and never providerShipmentId alone.
 * Identical repeats (same shipment, same type, same status) collapse onto the
 * same job idempotently, which is safe: the worker's per-shipment processing is
 * idempotent.
 */
function buildEventKey(
  providerEventId: string | undefined,
  providerShipmentId: string,
  eventType: ProviderLogisticsEventType,
  status: string | null,
): string {
  if (providerEventId !== undefined) {
    return `shipbubble:${providerEventId}`;
  }
  const statusPart = status ?? "no-status";
  return `shipbubble:${providerShipmentId}:${eventType}:${statusPart}`;
}