import { PromotionDiscountType } from "@api/domain/entities/Promotion";
import type { JsonObject, JsonValue } from "@api/domain/shared/json";

export type { JsonObject, JsonValue };

export interface StructuredMeta extends JsonObject {}

export interface TokenClaims extends JsonObject {}

export interface PasswordResetTokenClaims extends JsonObject {
  customerId: string;
  id?: string;
  expiresAt?: string;
}

export interface PasswordResetTokenIssueResult {
  token: string;
  id: string;
  expiresAt: string;
}

export interface CustomerAuthenticationMetadata {
  failedAttempts?: number;
  lastFailedAt?: string | null;
  lockUntil?: string | null;
  lastLoginAt?: string | null;
  passwordHash?: string;
  passwordUpdatedAt?: string;
  passwordResetTokenId?: string | null;
  passwordResetTokenHash?: string | null;
  passwordResetRequestedAt?: string | null;
  passwordResetExpiresAt?: string | null;
  securityStamp?: string;
  passwordResetRequestIp?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  addresses?: JsonObject[];
  metadata?: JsonObject;
}

export interface AddressBookEntry extends JsonObject {
  id: string;
}

export interface ProductReadQuery {
  salesChannelId?: string;
  regionId?: string;
  q?: string;
  limit?: number;
  offset?: number;
  expand?: string[];
  fields?: string[];
  [key: string]: JsonValue | undefined;
}

export interface TransactionClient {
  [key: string]: unknown;
}

export interface DatabaseTerminationResult {
  terminatedCount: number;
}

export interface DraftOrderItem {
  title: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface DraftOrderRecord {
  id: string;
  email: string;
  items: DraftOrderItem[];
  shippingAddress: JsonObject | null;
  totalMinor: number;
  status: "awaiting_payment";
  createdBy: string;
  createdAt: string;
  metadata: {
    createdByActor: string;
  };
}

export interface BusinessUnitMemberRecord {
  customerId: string;
  role: string;
}

export interface BusinessUnitRecord {
  id: string;
  name: string;
  registrationNumber: string;
  salesChannelId: string;
  members: BusinessUnitMemberRecord[];
  createdAt: string;
}

export interface FulfillmentRecord extends JsonObject {
  id: string;
  orderId: string;
  trackingNumber: string;
  /**
   * Provider shipment identity (e.g. Shipbubble order_id "SB-...").
   * First-class external identity — NEVER the application orderId.
   */
  providerShipmentId?: string;
  /**
   * Lifecycle state of the dispatch (see `DispatchState` in
   * domain/shared/dispatchStateMachine). The dispatch use case writes
   * `dispatch_pending` (attempt in progress, claimed before the provider POST),
   * `dispatched` (definite success), `requires_reconciliation` (ambiguous
   * outcome), or `failed` (terminal rejection). Courier-tracking events may
   * write downstream statuses.
   */
  status?: string;
  /**
   * The inventory location that actually fulfilled the order (the frozen
   * primary location from `Order.sourcingSnapshot`). The provider-neutral
   * dispatch flow uses it to resolve the shipment origin FROM the local
   * location record — never reconstructed from the logistics provider.
   */
  sourcingLocationId?: string;
}

/**
 * Shipping quote returned to the application by a logistics provider.
 *
 * The client-visible fields are `id` (opaque quote identity to select),
 * `serviceLevel`, `amountMinor`, `currency` and `etaDays`. The provider
 * selection fields (`courierId`, `serviceCode`, `requestToken`) are
 * application-persistence data the use-case layer stores so the SHIPMENT
 * CREATION step can be driven by an application-selected quote — they are
 * never exposed to the HTTP client.
 */
export interface ShippingQuote extends JsonObject {
  /** Deterministic application quote id the client selects; echoed back at selection. */
  id?: string;
  serviceLevel?: string;
  amountMinor?: number;
  currency?: string;
  etaDays?: number;
  /** Provider courier identity (persisted server-side, never returned to the client). */
  courierId?: string;
  /** Provider service code (persisted server-side, never returned to the client). */
  serviceCode?: string;
  /** Provider request token for the rate response (persisted server-side, never returned to the client). */
  requestToken?: string;
}

/**
 * Client-visible shipping quote shape returned by the quote-retrieval use case.
 * Contains ONLY the selectable quote identity and display fields — the provider
 * selection data (courierId, serviceCode, requestToken) is persisted
 * server-side and never crosses the client boundary.
 */
export interface PublicShippingQuote extends JsonObject {
  /** Deterministic application quote id the client selects. */
  id: string;
  /** Server-persisted display service level. */
  serviceLevel?: string | null;
  /** Server-validated quote amount in minor units. */
  amountMinor: number;
  /** ISO-4217 currency code of the quote, server-validated. */
  currency?: string | null;
  /** Estimated delivery days shown to the client. */
  etaDays?: number | null;
}

// ---------------------------------------------------------------------------
// Shipment creation contract (application -> logistics provider)
// ---------------------------------------------------------------------------

/**
 * A parcel item the application hands to the logistics provider at shipment
 * creation. Provider-neutral: the adapter maps it onto the provider's
 * package_items shape. `lineItemId` ties the parcel to a cart/order line so
 * quantities and weights can be reconciled (e.g. for returns).
 */
export interface ShipmentParcelItem {
  lineItemId: string;
  title: string;
  description?: string | null;
  quantity: number;
  unitPriceMinor: number;
  /** Weight in kilograms; provider defaults apply when omitted. */
  weightKg?: number | null;
}

/**
 * Receiver/shipping destination for a shipment. Provider-neutral subset of the
 * checkout shipping address; the adapter composes the provider's single-line
 * address string from these fields.
 */
export interface ShipmentDestination {
  name: string;
  email: string;
  phone: string;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
}

/**
 * The quote the APPLICATION selected (courier + service + frozen price). Used
 * both for the outbound shipment selected at checkout and for the RETURN courier
 * rate selected from a return-rates response. Shipment (and return label)
 * creation MUST be driven by this selection — the adapter must never
 * independently choose a courier.
 */
export interface ShippingOptionSelection {
  /** Opaque application quote id echoed from ShippingQuote.id. */
  quoteId: string;
  /** Provider courier identity (e.g. Shipbubble courier_id). */
  courierId: string;
  /** Provider service code (e.g. Shipbubble service_code). */
  serviceCode: string;
  /** Server-persisted display service level. */
  serviceLevel?: string | null;
  /** Server-persisted shipping amount in minor units, frozen at selection. */
  amountMinor: number;
  currency?: string | null;
  etaDays?: number | null;
}

/**
 * Provider-neutral shipping snapshot frozen onto the ORDER at checkout so the
 * dispatch/RMA flows are self-contained and never depend on the mutable cart.
 * Includes the provider request_token so the two-phase label flow survives the
 * gap between rate fetching and shipment creation.
 */
export interface OrderShippingSnapshot {
  /** Provider request token from the rate response the selection came from. */
  requestToken: string;
  /** The application-selected quote. */
  selection: ShippingOptionSelection;
  /** Receiver/destination of the shipment. */
  destination: ShipmentDestination;
  /** Parcel items to be shipped (name/description/weight/quantity). */
  parcelItems: ShipmentParcelItem[];
  /** Parcel dimensions in centimetres; provider/configured defaults apply when omitted. */
  dimensions?: { length: number; width: number; height: number } | null;
}

/**
 * Provider-neutral shipment origin (sender) frozen onto the ORDER from the
 * inventory location that sourced the order. The LOCAL `InventoryLocation`
 * record is the source of truth for a node's shipment origin — the logistics
 * provider NEVER becomes the source of truth, and the application never
 * invents an origin. `providerAddressCode` is an adapter-owned cache of the
 * provider's validated sender code, never a business input.
 */
export interface ShipmentOrigin {
  /** The inventory location id the origin resolves from. */
  locationId: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  providerAddressCode?: string | null;
}

/**
 * Provider-neutral sourcing snapshot frozen onto the ORDER at finalization.
 *
 * Records EXACTLY which inventory locations held the reserved units that
 * became the order (variant -> location -> quantity), the deterministic
 * primary fulfillment location, and the shipment origin resolved from that
 * location's LOCAL sender record. Dispatch/RMA flows consume this snapshot so
 * they are self-contained and never depend on the mutable inventory tables or
 * a provider decision. A null `origin` means the primary location carried no
 * complete sender record — dispatch degrades rather than inventing one.
 */
export interface OrderSourcingSnapshot {
  /** The ISO-8601 timestamp the snapshot was frozen at (order creation). */
  frozenAt: string;
  /** The reserved lines the order was built from, sorted by variantId. */
  variantLines: Array<{
    variantId: string;
    quantity: number;
    locationId: string;
  }>;
  /** Deterministic primary fulfillment location (majority by quantity; tie-break by smallest id). Null when no reservations. */
  primaryLocationId: string | null;
  /** Shipment origin resolved from the primary location's sender record; null when incomplete/absent. */
  origin: ShipmentOrigin | null;
}

/**
 * Everything the application supplies to create a shipment. The adapter uses
 * this verbatim — it never invents a courier, price, address or parcel.
 */
export interface ShippingLabelRequest extends OrderShippingSnapshot {
  /** Application order id the shipment belongs to (audit/traceability). */
  orderId: string;
  /**
   * Frozen shipment origin from `Order.sourcingSnapshot` (the LOCAL inventory
   * location record). Null when the order carries no sourcing snapshot (e.g. a
   * custom-only cart) or the location had no complete sender record. The
   * adapter validates the shape when present but never decides an origin.
   */
  origin?: ShipmentOrigin | null;
}

export interface ShippingLabelResult {
  /**
   * Label/waybill document URL. Shipbubble only supplies a waybill document for
   * couriers that require one, so this is legitimately null for some couriers —
   * the adapter never fabricates a label URL.
   */
  labelUrl?: string | null;
  trackingNumber: string;
  /** Provider shipment identity (e.g. "SB-..."). First-class; never the app orderId. */
  providerShipmentId: string;
  courier?: string | null;
  serviceLevel?: string | null;
}

/**
 * Provider identity of an existing shipment (label or return) used to cancel
 * or start follow-on operations. Always the PROVIDER's id, never the
 * application orderId.
 */
export interface ProviderShipmentReference {
  providerShipmentId: string;
  trackingNumber?: string | null;
}

/**
 * Request for a return (reverse) shipping label. Return labels originate from
 * the ORIGINAL outbound shipment's provider identity, plus the destination and
 * parcel items being returned. The return courier rate is supplied by the
 * APPLICATION (selected from the provider's return-rates response) so the
 * adapter never independently chooses a return courier.
 */
export interface ReturnLabelRequest {
  /** Application order id the return belongs to. */
  orderId: string;
  items: Array<{ lineItemId: string; quantity: number }>;
  /** Provider identity of the original outbound shipment. */
  originalShipment: ProviderShipmentReference;
  /** The customer's address the return label must pick up from. */
  destination: ShipmentDestination;
  parcelItems: ShipmentParcelItem[];
  /**
   * The RETURN courier + service rate the application selected from the return
   * rates response (provider courier_id + service_code drive the label).
   */
  returnSelection: ShippingOptionSelection;
}

export interface ReturnLabelResult {
  /**
   * Return label/waybill document URL. Some return couriers provide no waybill
   * document (waybill=false), so this is legitimately null — the adapter never
   * fabricates a label URL.
   */
  url?: string | null;
  /** Provider identity of the created return shipment (for later cancellation). */
  providerShipmentId: string;
}

// ---------------------------------------------------------------------------
// Inbound logistics event contract (provider webhook -> application)
// ---------------------------------------------------------------------------

/**
 * Logistics providers the application integrates with. Provider-neutral: the
 * provider-specific webhook mapper is the ONLY module that knows a provider's
 * raw payload shape; everything past it (domain, generic queue contracts,
 * application use cases) sees only these neutral identities.
 *
 * - `"shipbubble"` — the Shipbubble fulfilment provider (HMAC-signed webhook,
 *   events carry a provider shipment identity).
 * - `"courier"` — the generic courier-tracking webhook (no signature, events
 *   carry only a tracking number). Events from this provider reconcile the
 *   local fulfillment by tracking number (see
 *   `ProcessCourierTrackingEventUseCase`), never by a fabricated shipment id.
 */
export type LogisticsProvider = "shipbubble" | "courier";

/**
 * Normalized, provider-neutral logistics event vocabulary. The provider
 * webhook mapper maps one logical provider event onto exactly one normalized
 * type; provider payloads it does not understand map to "unknown" — never a
 * fabricated type, never a silently repurposed one.
 */
export const PROVIDER_LOGISTICS_EVENT_TYPES = [
  "shipment.created",
  "shipment.cancelled",
  "tracking.status_changed",
  "delivery.attempted",
  "delivery.completed",
  "delivery.exception",
  "unknown",
] as const;

export type ProviderLogisticsEventType =
  (typeof PROVIDER_LOGISTICS_EVENT_TYPES)[number];

/**
 * Provider-neutral logistics event the application receives from a logistics
 * provider's webhook.
 *
 * This is the ONLY shape that crosses the provider boundary inwards: the
 * provider-specific webhook mapper produces it, and the generic queue
 * contracts and application use cases consume it. It deliberately carries NO
 * API keys, auth headers, raw webhook bodies, or provider secrets.
 *
 * EVENT IDENTITY & IDEMPOTENCY (L5 PART 6): `eventKey` is the deterministic,
 * stable identity of ONE logical provider event and becomes the queue job id,
 * so one logical event -> exactly one job (duplicate deliveries and retries
 * collapse onto the same job via the queue's existing-id no-op). The mapper
 * derives it from STABLE provider fields ONLY:
 *   - a provider-supplied event id (`providerEventId`) when one exists;
 *   - otherwise a stable occurrence discriminator that distinguishes multiple
 *     events of the same shipment + type.
 * Never from a timestamp alone, a random UUID, or providerShipmentId alone (one
 * shipment emits many events). A payload offering NO stable identity is a
 * structural failure the mapper must reject permanently — never fabricate.
 */
export interface ProviderLogisticsEvent extends JsonObject {
  /** Provider identity (the discriminator; neutral to the domain). */
  provider: LogisticsProvider;
  /** Provider shipment identity — always the PROVIDER's id, never the app orderId. */
  providerShipmentId: string;
  /** Provider-normalized tracking number when the event carries one. */
  trackingNumber?: string | null;
  /** Courier name (provider-normalized) when known. */
  courier?: string | null;
  /** Normalized lifecycle event type. */
  eventType: ProviderLogisticsEventType;
  /**
   * Provider-reported status normalized onto the courier vocabulary
   * (in_transit | out_for_delivery | delivered | failed_attempt). Null when the
   * event type does not imply a courier status.
   */
  status?: string | null;
  /** Provider-reported occurrence time (ISO-8601) when supplied. */
  occurredAt?: string | null;
  /** Deterministic stable identity of this logical provider event (queue jobId). */
  eventKey: string;
  /** Provider's own event id when the payload supplied one (kept for traceability). */
  providerEventId?: string;
  /**
   * Whether the event's origin explicitly opts OUT of customer notification
   * (e.g. the courier-tracking webhook's `notifyCustomer: false`). Absent/true
   * keeps the default notify-on-tracking-change behavior.
   */
  notifyCustomer?: boolean;
  /** Provider-neutral structured extras. NEVER raw provider bodies or secrets. */
  metadata?: JsonObject;
}

/**
 * Immutable financial snapshot of the promotion that was applied to an order at
 * checkout time. Persisted on the order so its financial history does not depend
 * on the mutable `promotion` table state after the order is created.
 */
export interface PromotionSnapshot {
  promotionId: string;
  code: string;
  discountType: PromotionDiscountType;
  discountValueMinor: number;
  minimumSpendMinor: number;
  appliedDiscountMinor: number;
}

/**
 * Persistence snapshot of a Promotion applied to a CART. Unlike the order
 * snapshot, this is intentionally NOT a frozen financial record — the cart must
 * be able to deliberately re-resolve/revalidate its promotion against the
 * current `promotion` table, so the full config is stored so a real Promotion
 * domain entity can be reconstructed on hydration.
 */
export interface CartPromotionSnapshot {
  id: string;
  code: string;
  discountType: PromotionDiscountType;
  discountValueMinor: number;
  minimumSpendMinor: number;
  isActive: boolean;
}

/**
 * Authoritative, server-computed financial breakdown of a checkout charge.
 *
 * Every amount is an integer in minor units (Kobo/cents); NO floating-point
 * math is ever performed. The cart computes ONE authoritative breakdown
 * (`Cart.computeAuthoritativeCheckoutBreakdown`) which becomes the durable
 * payment obligation, the exact amount sent to the gateway, the expected amount
 * the webhook must match, and the frozen financial snapshot of the order.
 *
 * The invariant `totalMinor === subtotalMinor - discountMinor + taxMinor +
 * shippingMinor + insuranceMinor` is validated when the breakdown is persisted
 * (Payment entity) so a mis-priced charge is rejected before it reaches the
 * gateway.
 */
export interface PaymentAmountBreakdown {
  /** Σ line totals (unitPriceMinor × quantity) — server-priced line items. */
  subtotalMinor: number;
  /** Server-computed promotion discount, never trusted from the client. */
  discountMinor: number;
  /**
   * Server-computed regional tax (Cart.taxAmountMinor); 0 when none.
   *
   * HISTORICAL TAX SNAPSHOT DECISION: this AMOUNT is the authoritative frozen
   * financial record (INV-7). The tax RATE that produced it is NOT persisted
   * or reconstructed from live configuration — the amount is the source of
   * financial truth, and today's `region.tax_rate` changes can never alter an
   * existing obligation. The rate is only ever derived at calculation time
   * (SetCheckoutShippingAddressUseCase -> RegionalTaxCalculationService) and
   * frozen as this amount.
   */
  taxMinor: number;
  /** Selected shipping quote amount; 0 when none selected. */
  shippingMinor: number;
  /** Embedded insurance premium; 0 when not opted in. */
  insuranceMinor: number;
  /** The single authoritative charge amount = the sum of the parts above. */
  totalMinor: number;
}
