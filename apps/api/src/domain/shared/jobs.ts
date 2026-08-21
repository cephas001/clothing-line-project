// apps/api/src/domain/shared/jobs.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import {
  LogisticsProvider,
  PROVIDER_LOGISTICS_EVENT_TYPES,
  ProviderLogisticsEventType,
  PaymentAmountBreakdown,
} from "@api/domain/shared/contracts";
import { CourierTrackingState } from "@api/domain/shared/trackingStateMachine";
import {
  notificationAggregateId,
  type NotificationIntent,
  type NotificationOrderLine,
  type NotificationRecipient,
  type OrderNotificationContext,
} from "@api/domain/shared/notifications";

/**
 * Authoritative queue names for the background-job queues this application
 * publishes to and consumes from. Every producer, consumer, and worker must
 * reference these constants instead of embedding literal queue names, so the
 * contract lives in exactly one shared application location.
 */
export const QUEUE_NAMES = {
  paymentEvents: "payment-events-queue",
  bulkCatalogImport: "bulk-import-queue",
  logisticsEvents: "logistics-events-queue",
  notificationEvents: "notification-events-queue",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Typed job payload contracts for the background-job queues this application
 * publishes to and consumes from.
 *
 * These contracts mirror what the producers actually enqueue:
 * - `QueuePaymentEventUseCase` enqueues a typed `PaymentEventJobPayload` to
 *   `payment-events-queue`. The payload is a discriminated union keyed on
 *   `obligationType`:
 *     * `checkout` (`CheckoutPaymentEventJobPayload`) — fields `cartId`,
 *       `transactionReference`, `amountPaidMinor`, `currency`,
 *       `expectedAmountMinor`, `reportedCurrency`, produced by the provider
 *       webhook mapper for a settled checkout cart obligation.
 *     * `swap` (`SwapPaymentEventJobPayload`) — fields `swapId`, `orderId`,
 *       and the same payment fields, produced for a settled swap-upcharge
 *       obligation. The raw provider envelope is never queued.
 * - `ImportBulkCatalogDataUseCase` enqueues the bulk-import metadata to
 *   `bulk-import-queue`.
 * - The logistics webhook mapper/use case enqueues a typed
 *   `LogisticsEventJobPayload` to `logistics-events-queue`. The payload is a
 *   provider-neutral projection of a `ProviderLogisticsEvent`; its `eventKey`
 *   is the deterministic identity of ONE logical provider event and is used as
 *   the queue `jobId` (see PART 6 idempotency strategy in contracts.ts).
 *
 * Workers MUST parse job payloads with the exported `parse*` functions instead
 * of casting arbitrary JSON: a malformed payload is a permanent failure
 * (retrying cannot fix it), so the parsers reject it with a `VALIDATION_ERROR`
 * DomainError before any use case is invoked.
 */
export type PaymentObligationType = "checkout" | "swap";

export type CheckoutPaymentEventJobPayload = {
  obligationType: "checkout";
  cartId: string;
  transactionReference: string;
  /** Amount actually captured by the provider, in integer minor units. */
  amountPaidMinor: number;
  /**
   * ISO-4217 currency code (lowercase) of the charge. Populated from the
   * DURABLE payment obligation when one resolves; null for legacy webhooks.
   * The finalizer rejects a provider currency that disagrees with the
   * obligation.
   */
  currency: string | null;
  /**
   * The authoritative amount the obligation expected (the durable payment's
   * `amountMinor`). The finalizer requires the captured amount to equal this.
   * Null for legacy webhooks without a durable obligation (best-effort only).
   */
  expectedAmountMinor: number | null;
  /**
   * ISO-4217 currency code (lowercase) AS REPORTED BY THE PROVIDER WEBHOOK
   * (`data.currency`), distinct from `currency` (the obligation's authoritative
   * currency). The worker's financial verification compares this against the
   * durable obligation; a valid signature is not sufficient. Null when the
   * webhook carried no currency (or the event predates this field).
   */
  reportedCurrency: string | null;
};

export type SwapPaymentEventJobPayload = {
  obligationType: "swap";
  /**
   * The swap obligation's identity (`payment.obligationId`), derived from local
   * authoritative state — never provider-echoed metadata. The worker verifies
   * it resolves to the correct `swap.id`.
   */
  swapId: string;
  /**
   * The order the swap modifies (`swap.orderId`), derived from the durable
   * obligation's metadata. The worker cross-checks it against the swap row.
   */
  orderId: string;
  transactionReference: string;
  amountPaidMinor: number;
  currency: string | null;
  expectedAmountMinor: number | null;
  reportedCurrency: string | null;
};

export type PaymentEventJobPayload =
  | CheckoutPaymentEventJobPayload
  | SwapPaymentEventJobPayload;

export interface BulkCatalogImportJobPayload {
  jobId: string;
  adminUserId: string;
  fileUrl: string;
  fileType: "csv" | "json" | null;
  enqueuedAt: string;
}

/**
 * Typed job payload for `logistics-events-queue`. Provider-neutral projection
 * of a `ProviderLogisticsEvent` produced by the provider-specific webhook
 * mapper. `eventKey` is the deterministic identity of ONE logical provider
 * event and is used as the queue `jobId`, so one logical event maps to exactly
 * one job (duplicate deliveries and retries collapse onto the same job).
 * The payload carries NO API keys, auth headers, raw webhook bodies, or
 * provider secrets.
 */
export interface LogisticsEventJobPayload {
  provider: LogisticsProvider;
  eventKey: string;
  eventType: ProviderLogisticsEventType;
  providerShipmentId: string;
  trackingNumber?: string | null;
  courier?: string | null;
  status?: string | null;
  occurredAt?: string | null;
  /**
   * When the provider event explicitly opts OUT of customer notification
   * (e.g. the courier-tracking webhook's `notifyCustomer: false`). Absent/true
   * keeps the default notify-on-tracking-change behavior.
   */
  notifyCustomer?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field '${field}' is required and must be a non-empty string.`,
    );
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field '${field}' must be a non-empty string or null.`,
    );
  }
  return value.trim();
}

function readOptionalBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field '${field}' must be a boolean.`,
    );
  }
  return value;
}

/**
 * Validate an opaque job payload against the `PaymentEventJobPayload` contract.
 * The payload is discriminated on `obligationType` ("swap" vs "checkout").
 * `obligationType` is required for new producers; a payload without it is
 * treated as a legacy checkout event (pre-discrimination producers). Extra
 * gateway fields beyond the required ones are tolerated and ignored.
 */
export function parsePaymentEventJobPayload(
  value: unknown,
): PaymentEventJobPayload {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Payment event job payload must be an object.",
    );
  }

  const transactionReference = requiredString(
    value.transactionReference,
    "transactionReference",
  );
  const amountPaidMinor = value.amountPaidMinor;

  if (
    typeof amountPaidMinor !== "number" ||
    !Number.isInteger(amountPaidMinor) ||
    amountPaidMinor < 0
  ) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Job payload field 'amountPaidMinor' must be a non-negative integer.",
    );
  }

  // `currency` is optional at the wire level: null when the webhook carried no
  // currency or no durable obligation resolved. When present it must be a
  // non-empty ISO-4217 string.
  let currency: string | null = null;
  if (value.currency !== null && value.currency !== undefined) {
    if (typeof value.currency !== "string" || value.currency.trim() === "") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Job payload field 'currency' must be a non-empty string or null.",
      );
    }
    currency = value.currency.trim();
  }

  // `expectedAmountMinor` is optional at the wire level: null for legacy
  // webhooks with no durable obligation. When present it must be a
  // non-negative integer.
  let expectedAmountMinor: number | null = null;
  if (
    value.expectedAmountMinor !== null &&
    value.expectedAmountMinor !== undefined
  ) {
    if (
      typeof value.expectedAmountMinor !== "number" ||
      !Number.isInteger(value.expectedAmountMinor) ||
      value.expectedAmountMinor < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Job payload field 'expectedAmountMinor' must be a non-negative integer or null.",
      );
    }
    expectedAmountMinor = value.expectedAmountMinor;
  }

  // `reportedCurrency` is optional at the wire level (legacy jobs carry no such
  // field): null when the provider webhook reported no currency. When present
  // it must be a non-empty ISO-4217 string.
  let reportedCurrency: string | null = null;
  if (value.reportedCurrency !== null && value.reportedCurrency !== undefined) {
    if (
      typeof value.reportedCurrency !== "string" ||
      value.reportedCurrency.trim() === ""
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Job payload field 'reportedCurrency' must be a non-empty string or null.",
      );
    }
    reportedCurrency = value.reportedCurrency.trim();
  }

  // Discriminate on obligationType. A payload without it is a legacy checkout
  // event (pre-discrimination producers emitted only checkout payloads).
  if (value.obligationType === "swap") {
    const swapId = requiredString(value.swapId, "swapId");
    const orderId = requiredString(value.orderId, "orderId");
    return {
      obligationType: "swap",
      swapId,
      orderId,
      transactionReference,
      amountPaidMinor,
      currency,
      expectedAmountMinor,
      reportedCurrency,
    };
  }

  const cartId = requiredString(value.cartId, "cartId");
  return {
    obligationType: "checkout",
    cartId,
    transactionReference,
    amountPaidMinor,
    currency,
    expectedAmountMinor,
    reportedCurrency,
  };
}

/**
 * Validate an opaque job payload against the `BulkCatalogImportJobPayload`
 * contract.
 */
export function parseBulkCatalogImportJobPayload(
  value: unknown,
): BulkCatalogImportJobPayload {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Bulk catalog import job payload must be an object.",
    );
  }

  const jobId = requiredString(value.jobId, "jobId");
  const adminUserId = requiredString(value.adminUserId, "adminUserId");
  const fileUrl = requiredString(value.fileUrl, "fileUrl");
  const fileType = value.fileType;
  const enqueuedAt = requiredString(value.enqueuedAt, "enqueuedAt");

  if (fileType !== null && fileType !== "csv" && fileType !== "json") {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Job payload field 'fileType' must be 'csv', 'json', or null.",
    );
  }

  if (Number.isNaN(Date.parse(enqueuedAt))) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Job payload field 'enqueuedAt' must be a valid date string.",
    );
  }

  return { jobId, adminUserId, fileUrl, fileType, enqueuedAt };
}

/**
 * Validate an opaque job payload against the `LogisticsEventJobPayload`
 * contract. A malformed payload is a permanent failure (retrying cannot fix
 * it), so the parser rejects it with a `VALIDATION_ERROR` DomainError before
 * any worker invokes a use case.
 */
export function parseLogisticsEventJobPayload(
  value: unknown,
): LogisticsEventJobPayload {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Logistics event job payload must be an object.",
    );
  }

  const provider = requiredString(value.provider, "provider");
  if (provider !== "shipbubble" && provider !== "courier") {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field 'provider' must be a known logistics provider; received "${provider}".`,
    );
  }

  const eventKey = requiredString(value.eventKey, "eventKey");
  const eventType = requiredString(value.eventType, "eventType");
  if (
    !PROVIDER_LOGISTICS_EVENT_TYPES.includes(
      eventType as ProviderLogisticsEventType,
    )
  ) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field 'eventType' is not a known normalized logistics event type; received "${eventType}".`,
    );
  }
  const normalizedEventType = eventType as ProviderLogisticsEventType;

  const providerShipmentId = requiredString(
    value.providerShipmentId,
    "providerShipmentId",
  );
  const trackingNumber = optionalString(value.trackingNumber, "trackingNumber");
  const courier = optionalString(value.courier, "courier");
  const status = optionalString(value.status, "status");
  const occurredAt = optionalString(value.occurredAt, "occurredAt");
  if (occurredAt !== null && Number.isNaN(Date.parse(occurredAt))) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Job payload field 'occurredAt' must be a valid date string.",
    );
  }
  const notifyCustomer =
    value.notifyCustomer === undefined || value.notifyCustomer === null
      ? undefined
      : readOptionalBoolean(value.notifyCustomer, "notifyCustomer");

  // The queue contract is byte-identical to the pre-courier shape: an absent
  // notifyCustomer (the Shipbubble default) stays an OMITTED key — only an
  // explicit `false` (courier-tracking webhook) is carried into the queue.
  return {
    provider,
    eventKey,
    eventType: normalizedEventType,
    providerShipmentId,
    trackingNumber,
    courier,
    status,
    occurredAt,
    ...(notifyCustomer === undefined ? {} : { notifyCustomer }),
  };
}

const NOTIFICATION_INTENT_TYPES: readonly NotificationIntent["type"][] = [
  "payment_confirmation",
  "shipment_dispatched",
  "tracking_update",
  "refund_issued",
  "password_reset",
  "quote_approved",
  "draft_order_invoice",
];

/**
 * Typed job payload for `notification-events-queue`, produced by
 * `EnqueuePendingNotificationsUseCase` from durable notification outbox rows.
 *
 * The payload wraps the provider-neutral `NotificationIntent` (the full,
 * self-contained notification the worker relays to the concrete notification
 * provider) plus the durable outbox record id, which the notification worker
 * uses to mark the row dispatched or failed — never a provider raw identity or
 * any provider secret.
 *
 * `enqueuedAt` is the ISO-8601 enqueue timestamp, carried for traceability and
 * for bounded-at-least-once reconciliation of stuck rows.
 */
export interface NotificationEventJobPayload {
  /** Durable notification outbox record id the worker must reconcile. */
  outboxRecordId: string;
  /** Provider-neutral notification intent (full payload; no secrets). */
  intent: NotificationIntent;
  /** ISO-8601 enqueue time, for traceability. */
  enqueuedAt: string;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field '${field}' must be a non-negative integer.`,
    );
  }
  return value;
}

function requiredEmail(value: unknown, field: string): string {
  const email = requiredString(value, field);
  if (!email.includes("@")) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field '${field}' must be a valid email address.`,
    );
  }
  return email;
}

function requiredTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field '${field}' must be a valid date string.`,
    );
  }
  return timestamp;
}

function parseRecipient(value: unknown): NotificationRecipient {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Notification intent 'recipient' must be an object.",
    );
  }
  const email = requiredEmail(value.email, "intent.payload.recipient.email");
  const name = optionalString(value.name, "intent.payload.recipient.name");
  const phone = optionalString(value.phone, "intent.payload.recipient.phone");
  return { email, name, phone };
}

function parseOrderNotificationContext(value: unknown): OrderNotificationContext {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Notification intent 'order' context must be an object.",
    );
  }
  const orderId = requiredString(value.orderId, "intent.payload.order.orderId");
  const cartId = requiredString(value.cartId, "intent.payload.order.cartId");
  const customerId = requiredString(
    value.customerId,
    "intent.payload.order.customerId",
  );
  const currency = optionalString(value.currency, "intent.payload.order.currency");
  const createdAt = requiredTimestamp(
    value.createdAt,
    "intent.payload.order.createdAt",
  );
  return { orderId, cartId, customerId, currency, createdAt };
}

function parseNotificationOrderLine(value: unknown): NotificationOrderLine {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Notification intent 'lineItems' entries must be objects.",
    );
  }
  const id = requiredString(value.id, "intent.payload.lineItems.id");
  const variantId = optionalString(
    value.variantId,
    "intent.payload.lineItems.variantId",
  );
  const quantity = requiredNonNegativeInteger(
    value.quantity,
    "intent.payload.lineItems.quantity",
  );
  const unitPriceMinor = requiredNonNegativeInteger(
    value.unitPriceMinor,
    "intent.payload.lineItems.unitPriceMinor",
  );
  const title = optionalString(value.title, "intent.payload.lineItems.title");
  return { id, variantId, quantity, unitPriceMinor, title };
}

function parsePaymentAmountBreakdown(value: unknown): PaymentAmountBreakdown {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Notification intent 'breakdown' must be an object.",
    );
  }
  const subtotalMinor = requiredNonNegativeInteger(
    value.subtotalMinor,
    "intent.payload.breakdown.subtotalMinor",
  );
  const discountMinor = requiredNonNegativeInteger(
    value.discountMinor,
    "intent.payload.breakdown.discountMinor",
  );
  const taxMinor = requiredNonNegativeInteger(
    value.taxMinor,
    "intent.payload.breakdown.taxMinor",
  );
  const shippingMinor = requiredNonNegativeInteger(
    value.shippingMinor,
    "intent.payload.breakdown.shippingMinor",
  );
  const insuranceMinor = requiredNonNegativeInteger(
    value.insuranceMinor,
    "intent.payload.breakdown.insuranceMinor",
  );
  const totalMinor = requiredNonNegativeInteger(
    value.totalMinor,
    "intent.payload.breakdown.totalMinor",
  );
  return {
    subtotalMinor,
    discountMinor,
    taxMinor,
    shippingMinor,
    insuranceMinor,
    totalMinor,
  };
}

const COURIER_TRACKING_STATES: readonly CourierTrackingState[] = [
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
];

/**
 * Validate an opaque job payload against the `NotificationEventJobPayload`
 * contract. A malformed payload is a permanent failure (retrying cannot fix
 * it), so the parser rejects it with a `VALIDATION_ERROR` DomainError before
 * any worker invokes a use case.
 *
 * Every field of the wrapped `NotificationIntent` is validated against the
 * provider-neutral contract: financial values as non-negative integers and the
 * recipient as a structurally valid email, mirroring the producer-side
 * guarantee that provider recipients and amounts never come from an HTTP or
 * webhook body.
 */
export function parseNotificationEventJobPayload(
  value: unknown,
): NotificationEventJobPayload {
  if (!isRecord(value)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Notification event job payload must be an object.",
    );
  }

  const outboxRecordId = requiredString(value.outboxRecordId, "outboxRecordId");
  const enqueuedAt = requiredTimestamp(value.enqueuedAt, "enqueuedAt");

  if (!isRecord(value.intent)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Notification event job payload field 'intent' must be an object.",
    );
  }
  const type = requiredString(value.intent.type, "intent.type");
  if (!NOTIFICATION_INTENT_TYPES.includes(type as NotificationIntent["type"])) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Job payload field 'intent.type' is not a known notification intent type; received "${type}".`,
    );
  }

  const payload = isRecord(value.intent.payload)
    ? value.intent.payload
    : {};
  const recipient = parseRecipient(payload.recipient);

  let intent: NotificationIntent;
  switch (type as NotificationIntent["type"]) {
    case "payment_confirmation": {
      intent = {
        type: "payment_confirmation",
        payload: {
          recipient,
          order: parseOrderNotificationContext(payload.order),
          transactionReference: requiredString(
            payload.transactionReference,
            "intent.payload.transactionReference",
          ),
          breakdown: parsePaymentAmountBreakdown(payload.breakdown),
          paidAt: requiredTimestamp(payload.paidAt, "intent.payload.paidAt"),
          lineItems: Array.isArray(payload.lineItems)
            ? payload.lineItems.map(parseNotificationOrderLine)
            : [],
        },
      };
      break;
    }
    case "shipment_dispatched": {
      intent = {
        type: "shipment_dispatched",
        payload: {
          recipient,
          order: parseOrderNotificationContext(payload.order),
          fulfillmentId: requiredString(
            payload.fulfillmentId,
            "intent.payload.fulfillmentId",
          ),
          providerShipmentId: requiredString(
            payload.providerShipmentId,
            "intent.payload.providerShipmentId",
          ),
          trackingNumber: requiredString(
            payload.trackingNumber,
            "intent.payload.trackingNumber",
          ),
          courier: optionalString(payload.courier, "intent.payload.courier"),
          serviceLevel: optionalString(
            payload.serviceLevel,
            "intent.payload.serviceLevel",
          ),
          labelUrl: optionalString(payload.labelUrl, "intent.payload.labelUrl"),
          dispatchedAt: requiredTimestamp(
            payload.dispatchedAt,
            "intent.payload.dispatchedAt",
          ),
        },
      };
      break;
    }
    case "tracking_update": {
      const status = requiredString(payload.status, "intent.payload.status");
      if (!COURIER_TRACKING_STATES.includes(status as CourierTrackingState)) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Job payload field 'intent.payload.status' is not a known courier tracking state; received "${status}".`,
        );
      }
      const occurredAt = optionalString(
        payload.occurredAt,
        "intent.payload.occurredAt",
      );
      if (occurredAt !== null && Number.isNaN(Date.parse(occurredAt))) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "Job payload field 'intent.payload.occurredAt' must be a valid date string.",
        );
      }
      intent = {
        type: "tracking_update",
        payload: {
          recipient,
          order: parseOrderNotificationContext(payload.order),
          fulfillmentId: requiredString(
            payload.fulfillmentId,
            "intent.payload.fulfillmentId",
          ),
          trackingNumber: optionalString(
            payload.trackingNumber,
            "intent.payload.trackingNumber",
          ),
          courier: optionalString(payload.courier, "intent.payload.courier"),
          status: status as CourierTrackingState,
          occurredAt,
        },
      };
      break;
    }
    case "refund_issued": {
      const money = isRecord(payload.money) ? payload.money : {};
      const amountMinor = requiredNonNegativeInteger(
        money.amountMinor,
        "intent.payload.money.amountMinor",
      );
      const currency = requiredString(
        money.currency,
        "intent.payload.money.currency",
      );
      intent = {
        type: "refund_issued",
        payload: {
          recipient,
          order: parseOrderNotificationContext(payload.order),
          refundId: requiredString(payload.refundId, "intent.payload.refundId"),
          refundReference: requiredString(
            payload.refundReference,
            "intent.payload.refundReference",
          ),
          providerRefundReference: optionalString(
            payload.providerRefundReference,
            "intent.payload.providerRefundReference",
          ),
          money: { currency, amountMinor },
          reason: optionalString(payload.reason, "intent.payload.reason"),
          issuedAt: requiredTimestamp(payload.issuedAt, "intent.payload.issuedAt"),
        },
      };
      break;
    }
    case "password_reset": {
      intent = {
        type: "password_reset",
        payload: {
          recipient,
          customerId: requiredString(
            payload.customerId,
            "intent.payload.customerId",
          ),
          token: requiredString(payload.token, "intent.payload.token"),
          expiresInSeconds: requiredNonNegativeInteger(
            payload.expiresInSeconds,
            "intent.payload.expiresInSeconds",
          ),
          requestedAt: requiredTimestamp(
            payload.requestedAt,
            "intent.payload.requestedAt",
          ),
        },
      };
      break;
    }
    case "quote_approved": {
      intent = {
        type: "quote_approved",
        payload: {
          recipient,
          quoteId: requiredString(payload.quoteId, "intent.payload.quoteId"),
          businessUnitId: requiredString(
            payload.businessUnitId,
            "intent.payload.businessUnitId",
          ),
          approvedTotalMinor: requiredNonNegativeInteger(
            payload.approvedTotalMinor,
            "intent.payload.approvedTotalMinor",
          ),
          currency: optionalString(
            payload.currency,
            "intent.payload.currency",
          ),
          approvedBy: requiredString(
            payload.approvedBy,
            "intent.payload.approvedBy",
          ),
          approvedAt: requiredTimestamp(
            payload.approvedAt,
            "intent.payload.approvedAt",
          ),
          note: optionalString(payload.note, "intent.payload.note"),
        },
      };
      break;
    }
    case "draft_order_invoice": {
      intent = {
        type: "draft_order_invoice",
        payload: {
          recipient,
          draftOrderId: requiredString(
            payload.draftOrderId,
            "intent.payload.draftOrderId",
          ),
          totalMinor: requiredNonNegativeInteger(
            payload.totalMinor,
            "intent.payload.totalMinor",
          ),
          currency: optionalString(
            payload.currency,
            "intent.payload.currency",
          ),
          itemCount: requiredNonNegativeInteger(
            payload.itemCount,
            "intent.payload.itemCount",
          ),
          createdAt: requiredTimestamp(
            payload.createdAt,
            "intent.payload.createdAt",
          ),
        },
      };
      break;
    }
  }

  return { outboxRecordId, intent, enqueuedAt };
}

/**
 * Deterministic queue jobId for one logical notification, built from the
 * provider-neutral intent. Job ids are stable across retries and duplicate
 * deliveries, so BullMQ collapses duplicate enqueues onto the same job (while
 * the job exists) and the outbox sweep can never double-enqueue the same
 * logical notification twice.
 *
 * Shape: `notification:<eventType>:<aggregateId>[:<discriminator>]`.
 * The discriminator is the per-occurrence identity for intents that fire more
 * than once per aggregate (e.g. a courier `tracking_update` keyed by eventKey),
 * and null/omitted for intents that fire at most once per aggregate (e.g. a
 * payment_confirmation for one order).
 */
export function buildNotificationJobId(
  intent: NotificationIntent,
  discriminator?: string | null,
): string {
  const base = `notification:${intent.type}:${sanitizeJobKey(
    notificationAggregateId(intent),
  )}`;
  const disc = discriminator && discriminator.trim().length > 0 ? discriminator : null;
  return disc ? `${base}:${sanitizeJobKey(disc)}` : base;
}

function sanitizeJobKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Cannot build a notification job id from an empty key segment.",
    );
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}
