// apps/api/src/domain/shared/notifications.ts

// Provider-neutral notification contract and payload DTOs (L8).
//
// ARCHITECTURAL RESPONSIBILITY (L8 PART 2/3):
//   Domain    — defines notification INTENT only (the methods + payload shapes
//                in this file). The domain knows nothing about Resend,
//                SendGrid, BullMQ, a provider message id, or a template.
//   Application — use cases build the payloads EXCLUSIVELY from authoritative
//                committed state and call the intent method AFTER the
//                transaction commits (or enqueue the intent through the
//                notification outbox — a later part). A notification NEVER
//                determines whether business state commits, never runs inside
//                a DB transaction, and never rolls back committed state.
//   Infrastructure — a concrete adapter maps each intent onto a provider
//                (email/SMS) call. Provider message ids, template ids, and
//                raw provider envelopes NEVER appear in this contract.
//
// RECIPIENT SAFETY (L8 PART 16):
//   A recipient is NEVER accepted from an arbitrary HTTP body or webhook.
//   Every `NotificationRecipient` is derived by the use case from authoritative
//   application state:
//     - customer email: `customer.email` resolved via ICustomerRepository;
//     - checkout/fulfillment flows: the FROZEN `Order.shippingSnapshot.destination.email`
//       recorded at checkout (never today's cart);
//     - draft-order invoice: the durable `DraftOrderRecord.email`;
//     - quote approval: the quote requester's `customer.email`.
//
// FINANCIAL INTEGRITY (L8 PART 4):
//   Every monetary value in these payloads comes from a FROZEN authoritative
//   record/snapshot — the durable `Payment` obligation, the `Order` frozen
//   financial snapshot, `Refund.amountMinor`, or `Quote.approvedTotalMinor`.
//   Financial values are NEVER recomputed from today's Product / Tax /
//   Promotion configuration. All amounts are integers in minor units and
//   always travel with their ISO-4217 currency code.

import { CourierTrackingState } from "@api/domain/shared/trackingStateMachine";
import { PaymentAmountBreakdown } from "@api/domain/shared/contracts";

// ---------------------------------------------------------------------------
// Recipient (Customer payload)
// ---------------------------------------------------------------------------

/**
 * Authoritative notification recipient. `email` is ALWAYS derived from
 * committed application state by the use case (see module doc); it is never
 * accepted from a request/webhook body. `name`/`phone` are best-effort
 * complements resolved from the same authoritative source.
 */
export interface NotificationRecipient {
  /** Authoritative, normalized (lowercased) email from committed state. */
  email: string;
  /** Display name (e.g. `customer.firstName`); never required for delivery. */
  name?: string | null;
  /** Phone number for SMS-capable channels when the provider supports it. */
  phone?: string | null;
}

// ---------------------------------------------------------------------------
// Shared money + order context
// ---------------------------------------------------------------------------

/** A frozen monetary value in integer minor units with its currency. */
export interface NotificationMoneyValue {
  /** ISO-4217 currency code (lowercase), matching the authoritative record. */
  currency: string;
  /** Non-negative integer amount in minor units (Kobo/cents). */
  amountMinor: number;
}

/**
 * Minimal ORDER context shared by every order-scoped notification payload.
 * Every field comes from the committed `Order` aggregate — never from a live
 * cart, live pricing, or a webhook. The financial breakdown nested by the
 * payment payload is the frozen `Payment.breakdown` / `Order` snapshot.
 */
export interface OrderNotificationContext {
  orderId: string;
  cartId: string;
  customerId: string;
  /** ISO-4217 currency code (lowercase) frozen on the order. */
  currency: string | null;
  /** Order creation timestamp (ISO-8601). */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Payment intent (L8 PART 4)
// ---------------------------------------------------------------------------

/**
 * Payment confirmation delivered after a verified charge settles.
 *
 * FINANCIAL SOURCE: the nested `breakdown` is the DURABLE `Payment` obligation
 * breakdown (subtotal/discount/tax/shipping/insurance/total in minor units) —
 * the exact frozen values the gateway captured and the webhook verified. They
 * are NEVER recomputed from today's catalog/promotion/tax configuration.
 */
export interface PaymentConfirmationNotification {
  recipient: NotificationRecipient;
  order: OrderNotificationContext;
  /** The transaction's idempotency reference (order.transactionReference). */
  transactionReference: string;
  /** Frozen authoritative charge breakdown from the durable obligation. */
  breakdown: PaymentAmountBreakdown;
  /** Charge capture timestamp (ISO-8601) from the verified event. */
  paidAt: string;
  /** Order line summary from the frozen order snapshot. */
  lineItems: NotificationOrderLine[];
}

/**
 * A single order line referenced by a notification. Financial values
 * (`unitPriceMinor`, `quantity`) come from the frozen order snapshot; titles
 * are resolved from frozen snapshot data only — never the live product catalog.
 */
export interface NotificationOrderLine {
  /** Order line item id (frozen). */
  id: string;
  variantId?: string | null;
  quantity: number;
  /** Frozen unit price in minor units. */
  unitPriceMinor: number;
  /** Frozen title/name when the snapshot carries one; otherwise null. */
  title?: string | null;
}

// ---------------------------------------------------------------------------
// Fulfillment + Tracking intents
// ---------------------------------------------------------------------------

/**
 * Shipment-dispatched notification delivered after a confirmed dispatch.
 *
 * SOURCE: the durable `FulfillmentRecord` written by
 * DispatchOrderFulfillmentUseCase (providerShipmentId, trackingNumber, courier,
 * serviceLevel, labelUrl) AFTER the dispatch transaction commits. Never
 * reconstructed from a webhook.
 */
export interface ShipmentDispatchedNotification {
  recipient: NotificationRecipient;
  order: OrderNotificationContext;
  fulfillmentId: string;
  /** First-class PROVIDER shipment identity — never the application orderId. */
  providerShipmentId: string;
  trackingNumber: string;
  courier?: string | null;
  serviceLevel?: string | null;
  /** Label/waybill URL when the provider supplied one (never fabricated). */
  labelUrl?: string | null;
  /** Dispatch confirmation timestamp (ISO-8601). */
  dispatchedAt: string;
}

/**
 * Courier tracking-progress notification delivered when the tracking state
 * machine advances (in_transit / out_for_delivery / delivered /
 * delivery_failed).
 *
 * SOURCE: the persisted `FulfillmentRecord.metadata.tracking` state machine
 * result from ProcessCourierTrackingEventUseCase, AFTER commit. `status` is a
 * `CourierTrackingState`, not a raw provider status string.
 */
export interface TrackingUpdateNotification {
  recipient: NotificationRecipient;
  order: OrderNotificationContext;
  fulfillmentId: string;
  trackingNumber?: string | null;
  courier?: string | null;
  /** Normalized courier tracking state produced by the domain state machine. */
  status: CourierTrackingState;
  /** Provider-reported occurrence time (ISO-8601) when supplied. */
  occurredAt?: string | null;
}

// ---------------------------------------------------------------------------
// Refund intent
// ---------------------------------------------------------------------------

/**
 * Refund-issued notification delivered after a refund dispatch is confirmed.
 *
 * FINANCIAL SOURCE: `Refund.amountMinor` + `Refund.currency` (the durable,
 * idempotent refund record) — never a recomputed proration. `refundReference`
 * is the app-generated idempotency key; `providerRefundReference` is the
 * provider's confirmation reference when returned.
 */
export interface RefundIssuedNotification {
  recipient: NotificationRecipient;
  order: OrderNotificationContext;
  refundId: string;
  /** App-generated idempotent refund reference. */
  refundReference: string;
  /** Provider refund reference once dispatch is confirmed (nullable). */
  providerRefundReference?: string | null;
  money: NotificationMoneyValue;
  reason?: string | null;
  /** Refund dispatch confirmation timestamp (ISO-8601). */
  issuedAt: string;
}

// ---------------------------------------------------------------------------
// Account / B2B / draft-order intents
// ---------------------------------------------------------------------------

/**
 * Password-reset notification.
 *
 * SOURCE: `customer.email` (authoritative), the issued single-use token, and
 * the TTL the token service granted. The raw token is legitimate here — the
 * notification cannot compose the reset link without it. The token never
 * travels through a queue payload (L8 later parts may split token delivery
 * from the async pipeline for this reason).
 */
export interface PasswordResetNotification {
  recipient: NotificationRecipient;
  customerId: string;
  /** Single-use reset token issued by the token service. */
  token: string;
  /** Seconds until the token expires (from the token service). */
  expiresInSeconds: number;
  /** Request context for the reset (requestedAt ISO-8601). */
  requestedAt: string;
}

/**
 * B2B quote-approval notification.
 *
 * FINANCIAL SOURCE: `approvedTotalMinor` frozen on the approved `Quote`
 * aggregate by `Quote.approve(...)` — never recomputed. Recipient is the quote
 * requester's authoritative `customer.email`.
 */
export interface QuoteApprovedNotification {
  recipient: NotificationRecipient;
  quoteId: string;
  businessUnitId: string;
  /** Frozen approved total in minor units. */
  approvedTotalMinor: number;
  /** ISO-4217 currency code when the quote snapshot carries one. */
  currency?: string | null;
  approvedBy: string;
  approvedAt: string;
  note?: string | null;
}

/**
 * Draft-order invoice notification.
 *
 * SOURCE: the durable `DraftOrderRecord` (email, totalMinor, items) persisted
 * by GenerateDraftOrderUseCase — the email is the record's own authoritative
 * address, not a fresh body value at send time.
 */
export interface DraftOrderInvoiceNotification {
  recipient: NotificationRecipient;
  draftOrderId: string;
  totalMinor: number;
  currency?: string | null;
  itemCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Discriminated notification intent (for the async dispatch path)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral notification intent: a discriminated union of every
 * notification the application can emit. Use cases that dispatch notifications
 * asynchronously (outbox/queue, later L8 parts) enqueue ONE of these intents
 * with a deterministic idempotency key; concrete adapters consume the same
 * union. No provider message ids, templates, API keys, or raw envelopes.
 */
export type NotificationIntent =
  | { type: "payment_confirmation"; payload: PaymentConfirmationNotification }
  | { type: "shipment_dispatched"; payload: ShipmentDispatchedNotification }
  | { type: "tracking_update"; payload: TrackingUpdateNotification }
  | { type: "refund_issued"; payload: RefundIssuedNotification }
  | { type: "password_reset"; payload: PasswordResetNotification }
  | { type: "quote_approved"; payload: QuoteApprovedNotification }
  | { type: "draft_order_invoice"; payload: DraftOrderInvoiceNotification };

// ---------------------------------------------------------------------------
// Provider-neutral service contract (L8 PART 2/3)
// ---------------------------------------------------------------------------

/**
 * Application notification intent, provider-neutral.
 *
 * This contract represents WHAT the application wants to notify about — it is
 * deliberately NOT a channel abstraction. There is no provider message id, no
 * template, no "sendEmail" primitive: the domain describes business outcomes
 * (payment confirmed, shipment dispatched, ...) and an infrastructure adapter
 * decides the channel(s).
 *
 * ORDERING INVARIANTS (caller responsibilities, enforced by the use cases in
 * later L8 parts):
 *   1. Every method runs AFTER the authoritative business state has committed
 *      (or after the intent is durably enqueued in the same transaction).
 *   2. No implementation of this contract is ever awaited inside a database
 *      transaction, and no provider call happens inside one.
 *   3. A thrown/failed notification NEVER rolls back committed state — callers
 *      treat delivery as best-effort and audit/log the failure.
 *   4. Financial payload values always come from frozen authoritative records.
 */
/**
 * Outcome of a successful provider dispatch. The provider-assigned message id
 * is the durable delivery receipt the notification worker persists on the
 * outbox row (`markDispatched`); it is `null` when the adapter suppressed the
 * send (recipient preference) or the provider returned no id. The id is a
 * RECEIPT, never a routing key — it is never used to re-send.
 */
export interface NotificationDispatchResult {
  providerMessageId: string | null;
}

export interface INotificationService {
  sendPaymentConfirmation(
    notification: PaymentConfirmationNotification,
  ): Promise<NotificationDispatchResult>;
  sendShipmentDispatched(
    notification: ShipmentDispatchedNotification,
  ): Promise<NotificationDispatchResult>;
  sendTrackingUpdate(
    notification: TrackingUpdateNotification,
  ): Promise<NotificationDispatchResult>;
  sendRefundIssued(
    notification: RefundIssuedNotification,
  ): Promise<NotificationDispatchResult>;
  sendPasswordReset(
    notification: PasswordResetNotification,
  ): Promise<NotificationDispatchResult>;
  sendQuoteApproved(
    notification: QuoteApprovedNotification,
  ): Promise<NotificationDispatchResult>;
  sendDraftOrderInvoice(
    notification: DraftOrderInvoiceNotification,
  ): Promise<NotificationDispatchResult>;
}

/**
 * The single authoritative aggregate the intent belongs to, used as the stable
 * idempotency key segment for the notification outbox and the notification
 * queue jobId. One logical notification target per intent: an order for
 * order-scoped intents, a fulfillment for shipment/tracking intents, a refund,
 * a customer, a quote, or a draft order.
 *
 * Per-occurrence intents (a courier `tracking_update` fires repeatedly for the
 * same fulfillment) are disambiguated by an ADDITIONAL discriminator carried
 * separately in the outbox row, not by this aggregate id.
 */
export function notificationAggregateId(intent: NotificationIntent): string {
  switch (intent.type) {
    case "payment_confirmation":
      return intent.payload.order.orderId;
    case "shipment_dispatched":
      return intent.payload.fulfillmentId;
    case "tracking_update":
      return intent.payload.fulfillmentId;
    case "refund_issued":
      return intent.payload.order.orderId;
    case "password_reset":
      return intent.payload.customerId;
    case "quote_approved":
      return intent.payload.quoteId;
    case "draft_order_invoice":
      return intent.payload.draftOrderId;
  }
}