// apps/api/src/infrastructure/database/schema/types.ts
//
// Relational schema type derived from the domain model (apps/api/src/domain).
// Tables are named in snake_case; columns mirror the entity/property shapes
// returned by the domain persistence contracts (domain/shared/contracts.ts).
//
// Conventions:
//   - `id` (text UUID) is always application-generated via IIdGenerator, so it
//     is a plain `string`, NOT `Generated`. Inserts always supply it.
//   - `created_at` / `updated_at` use the SQL default `now()`, so they are
//     `Generated`. Inserts may still pass an explicit value.
//   - Monetary values are integer minor units (`number`), never floats.
//   - Percentages are preserved as integer basis points (`number`).
//   - Collection value objects (addresses, members, proposed changes, items,
//     provider lists) are stored as JSONB and typed against the domain shapes
//     they serialize. Genuine relational children (line items, transactions,
//     money amounts) are normalized into their own tables with foreign keys.

import { ColumnType, Generated } from "kysely";
import { JsonObject } from "@api/domain/shared/json";
import {
  AddressBookEntry,
  BusinessUnitMemberRecord,
  CartPromotionSnapshot,
  DraftOrderItem,
  OrderShippingSnapshot,
  OrderSourcingSnapshot,
  PromotionSnapshot,
  ShippingQuote,
} from "@api/domain/shared/contracts";
import { FulfillmentStatus, PaymentStatus } from "@api/domain/entities/Order";
import { PaymentObligationType, PaymentState } from "@api/domain/entities/Payment";
import { RefundStatus } from "@api/domain/entities/Refund";
import { OrderEditChange } from "@api/domain/entities/OrderEdit";
import { PromotionDiscountType } from "@api/domain/entities/Promotion";
import { QuoteStatus } from "@api/domain/entities/Quote";
import { ReturnAuthorizationItem } from "@api/domain/entities/ReturnAuthorization";
import { NotificationIntent } from "@api/domain/shared/notifications";

/**
 * JSONB column: reads return the domain JSON shape `T`; writes accept either
 * `T` or a pre-serialized JSON string. The pg driver does not auto-serialize
 * arrays/objects, so repositories pass `JSON.stringify(...)` for array columns.
 */
type JsonB<T = JsonObject> = ColumnType<T, T | string, T | string>;

export interface Database {
  // ---------------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------------

  /** domain/entities/SalesChannel */
  sales_channel: {
    id: string;
    name: string;
    description: string | null;
    is_disabled: boolean;
    created_at: Generated<string>;
  };

  /** domain/entities/Product. Handle is globally unique. */
  product: {
    id: string;
    title: string;
    /** Normalized slug; unique (CreateProductUseCase fast-fails on duplicates). */
    handle: string;
    description: string | null;
  };

  /** domain/entities/ProductVariant. SKU is globally unique. */
  product_variant: {
    id: string;
    product_id: string;
    /** Normalized uppercase SKU; unique. */
    sku: string;
    inventory_quantity: number;
    allow_backorder: boolean;
    /** Optimistic-lock version; incremented on every inventory mutation. */
    version: number;
  };

  /** domain/entities/MoneyAmount — regional price of a variant. */
  money_amount: {
    id: string;
    variant_id: string;
    region_id: string;
    amount_minor: number;
  };

  /**
   * L9 — authoritative fulfillment/sourcing node. The LOCAL sender/origin
   * record is the source of truth for a node's shipment origin (Shipbubble
   * NEVER becomes the source of truth); `provider_address_code` is an
   * adapter-owned cache of the provider's validated code, never a business
   * input.
   */
  inventory_location: {
    id: string;
    /** Normalized unique node code (e.g. "LAGOS-WH"). */
    code: string;
    name: string;
    is_active: boolean;
    /** Verified sender/origin record (name/email/phone/address); JSONB. */
    sender_address: JsonB;
    /** Provider-validated sender address code; adapter-owned cache. */
    provider_address_code: string | null;
    /**
     * Deterministic sourcing preference — LOWER value = MORE preferred origin.
     * NULL (legacy/seed nodes) sorts LAST so configured nodes always win. The
     * single-origin selection sorts by (priority NULLS LAST, code, id).
     */
    priority: number | null;
    created_at: Generated<string>;
    updated_at: Generated<string>;
  };

  /**
   * L9 — per-(variant, location) stock ledger. `available_quantity` and
   * `reserved_quantity` carry DB CHECKs (>= 0) so negative stock is impossible;
   * UNIQUE(variant_id, location_id) allows exactly one authoritative level per
   * node; `version` is the optimistic-lock counter for repositories (mirroring
   * `product_variant.version`). The atomic conditional UPDATE pattern (guarded
   * by `available_quantity >= :qty`) is the final concurrency guard for
   * reservations.
   */
  inventory_level: {
    id: string;
    variant_id: string;
    location_id: string;
    available_quantity: number;
    reserved_quantity: number;
    /** Optimistic-lock version; incremented on every level mutation. */
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
  };

  /**
   * L9 — durable reservation ledger. `reservation_key` is UNIQUE (app-generated
   * idempotency key), so a retried/concurrent duplicate reservation collides
   * and rolls back the whole unit of work instead of double-reserving. The
   * `quantity > 0` CHECK rejects zero/negative reservations at the engine.
   */
  inventory_reservation: {
    id: string;
    reservation_key: string;
    location_id: string;
    variant_id: string;
    quantity: number;
    /**
     * Lifecycle: reserved | confirmed | released | cancelled | expired. The
     * DB default 'pending' is a legacy fallback for manual inserts only; the
     * application always writes an explicit status.
     */
    status: string;
    /** Optional link to the order that consumed the reservation. */
    order_id: string | null;
    expires_at: string | null;
    version: number;
    created_at: Generated<string>;
    updated_at: Generated<string>;
  };

  /** domain/entities/Category. Self-referential tree via parent_category_id. */
  category: {
    id: string;
    name: string;
    parent_category_id: string | null;
    created_at: Generated<string>;
  };

  /** Product <-> Category membership (Product.categoryIds). */
  product_category: {
    product_id: string;
    category_id: string;
  };

  /** Product <-> SalesChannel membership (Product.salesChannelIds). */
  product_sales_channel: {
    product_id: string;
    sales_channel_id: string;
  };

  /** domain/entities/Collection */
  collection: {
    id: string;
    title: string;
  };

  /** domain/entities/Region */
  region: {
    id: string;
    name: string;
    /** ISO-4217, stored lowercase (e.g. "ngn"). */
    currency_code: string;
    /** Basis points, e.g. 1250 = 12.5%. */
    tax_rate: number;
    payment_providers: JsonB<string[]>;
    fulfillment_providers: JsonB<string[]>;
  };

  // ---------------------------------------------------------------------------
  // Customers & auth
  // ---------------------------------------------------------------------------

  /** domain/entities/Customer. Email is normalized to lowercase and unique. */
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    active_cart_id: string | null;
    password_hash: string | null;
    registered_at: string | null;
    phone: string | null;
    /** Value-object address book (AddressBookEntry[]); serialized JSONB. */
    addresses: JsonB<AddressBookEntry[]>;
    security_stamp: string | null;
    password_updated_at: string | null;
    failed: number | null;
    last_failed_at: string | null;
    lock_until: string | null;
    last_login_at: string | null;
    disabled: boolean;
    roles: JsonB<string[]>;
    password_reset_token_id: string | null;
    password_reset_token_hash: string | null;
    password_reset_requested_at: string | null;
    password_reset_expires_at: string | null;
    /** IP that issued the most recent password reset request. */
    password_reset_request_ip: string | null;
    metadata: JsonB;
  };

  /** domain/entities/Role */
  role: {
    id: string;
    name: string;
    permissions: JsonB<string[]>;
  };

  // ---------------------------------------------------------------------------
  // Cart
  // ---------------------------------------------------------------------------

  /** domain/entities/Cart */
  cart: {
    id: string;
    region_id: string;
    sales_channel_id: string;
    customer_id: string | null;
    email: string | null;
    country_code: string | null;
    /** Value-object shipping address; serialized JSONB. */
    shipping_address: JsonB | null;
    /**
     * Optimistic-lock version. Incremented on every cart mutation (touch) and
     * guarded by PostgresCartRepository.save() against the version the
     * aggregate was loaded with; a stale concurrent writer is rejected with
     * RepositoryErrorCode.LOCKED instead of silently overwriting (L4
     * save/reset race correction).
     */
    version: number;
    /**
     * Applied promotion snapshot (CartPromotionSnapshot: full config so a real
     * Promotion entity can be reconstructed on hydration); set via
     * applyDiscount().
     */
    discount: JsonB<CartPromotionSnapshot> | null;
    tax_amount_minor: number | null;
    /**
     * Server-persisted selected shipping amount in minor units; the checkout
     * total trusts ONLY this durable value (never a client-supplied amount).
     */
    shipping_amount_minor: number | null;
    /** Server-persisted selected shipping service level. */
    shipping_service_level: string | null;
    /**
     * Server-persisted provider request token from the rate response the
     * selected shipping quote came from; required to create the shipment later.
     */
    shipping_request_token: string | null;
    /** Server-persisted provider courier identity of the selected shipping quote. */
    shipping_courier_id: string | null;
    /** Server-persisted provider service code of the selected shipping quote. */
    shipping_service_code: string | null;
    /**
     * Application identity of the server-validated quote the client selected.
     * Present ONLY when the whole shipping selection is present.
     */
    shipping_quote_id: string | null;
    /** Server-persisted ISO-4217 currency code of the selected shipping quote. */
    shipping_currency: string | null;
    /**
     * Server-persisted quote list from the latest rate response (includes the
     * provider selection fields; NEVER exposed to the client). Selection
     * resolves against this list for an authoritative amount/currency.
     */
    shipping_quotes: JsonB<ShippingQuote[]> | null;
    /**
     * Canonical fingerprint of the cart's material quote inputs at rate-retrieval
     * time. A selection is valid ONLY while the current cart computes the same
     * fingerprint, so a mutated cart can never select or charge a stale quote.
     */
    shipping_quote_fingerprint: string | null;
    /** Server-persisted insurance premium in minor units; null when not opted in. */
    insurance_amount_minor: number | null;
    metadata: JsonB;
    frozen: boolean;
    frozen_reason: string | null;
    frozen_at: string | null;
    order_id: string | null;
    converted_at: string | null;
    status: string;
    payment_status: string;
    payment_initialized: boolean;
    payment_authorization_url: string | null;
    payment_initialized_at: string | null;
    /**
     * Durable, app-generated payment reference supplied to the gateway at
     * initialization. Mirrors the authoritative `payment` row (obligation
     * checkout/cartId) so the checkout aggregate carries its own reference.
     */
    payment_reference: string | null;
    created_at: Generated<string>;
    /** Last-mutation timestamp; drives abandoned-cart pruning. */
    updated_at: Generated<string>;
  };

  /** domain/entities/CartLineItem */
  cart_line_item: {
    id: string;
    cart_id: string;
    /** Null for custom (manual) items. */
    variant_id: string | null;
    title: string | null;
    quantity: number;
    unit_price_minor: number;
    metadata: JsonB;
    created_at: Generated<string>;
  };

  // ---------------------------------------------------------------------------
  // Checkout & orders
  // ---------------------------------------------------------------------------

  /** domain/entities/Order. Transaction reference is unique for idempotency. */
  order: {
    id: string;
    cart_id: string;
    customer_id: string;
    total_minor: number;
    /** ISO-4217 currency code (lowercase) of the captured charge. */
    currency: string | null;
    /** Frozen subtotal (Σ line totals) at order time, minor units. */
    subtotal_minor: number;
    /** Frozen promotion discount at order time, minor units. */
    discount_minor: number;
    /** Frozen regional tax at order time, minor units. */
    tax_minor: number;
    /** Frozen shipping amount at order time, minor units. */
    shipping_minor: number;
    /** Frozen insurance premium at order time, minor units. */
    insurance_minor: number;
    fulfillment_status: FulfillmentStatus;
    payment_status: PaymentStatus;
    transaction_reference: string | null;
    payment_status_reason: string | null;
    payment_status_updated_at: string | null;
    flagged_for_review: boolean;
    flag_reason: string | null;
    risk_score: number | null;
    flagged_at: string | null;
    fulfillment_halted_at: string | null;
    /**
     * Frozen PromotionSnapshot recorded at checkout; the order's financial
     * history does not depend on the mutable `promotion` table.
     */
    promotion_snapshot: JsonB<PromotionSnapshot> | null;
    /**
     * Frozen provider-neutral shipping snapshot (destination, parcel items,
     * selected quote, request_token) recorded at checkout so dispatch and
     * return flows are self-contained.
     */
    shipping_snapshot: JsonB<OrderShippingSnapshot> | null;
    /**
     * Frozen provider-neutral sourcing snapshot (variant -> location ->
     * quantity, primary location, shipment origin) recorded at finalization so
     * dispatch/RMA flows are self-contained and never depend on the mutable
     * inventory tables or a provider decision.
     */
    sourcing_snapshot: JsonB<OrderSourcingSnapshot> | null;
    created_at: Generated<string>;
  };

  /** domain/entities/Order line items (OrderLineItem). */
  order_line_item: {
    id: string;
    order_id: string;
    /** Null for custom items added via order edits. */
    variant_id: string | null;
    quantity: number;
    unit_price_minor: number;
    fulfilled_quantity: number | null;
  };

  /** domain/entities/Transaction. Gateway reference is unique for idempotency. */
  transaction: {
    id: string;
    order_id: string;
    amount_minor: number;
    reference: string;
    created_at: Generated<string>;
  };

  /**
   * domain/entities/Payment — durable payment obligation. One row per
   * obligation (checkout cart, swap, order edit), an app-generated
   * `reference` (unique) that is passed to the gateway up front, and the
   * provider-returned reference (unique when present). The database UNIQUE
   * constraints are the final concurrency guard for payment idempotency.
   */
  payment: {
    id: string;
    obligation_type: PaymentObligationType;
    obligation_id: string;
    /** App-generated idempotency reference; unique. Passed to the gateway. */
    reference: string;
    /** Provider (Paystack) transaction reference; unique when present. */
    provider_reference: string | null;
    provider_payment_url: string | null;
    amount_minor: number;
    /** ISO-4217 currency (lowercase); authoritative for checkout obligations. */
    currency: string | null;
    /** Server-computed subtotal (Σ line totals) at obligation time. */
    subtotal_minor: number;
    /** Server-computed promotion discount at obligation time. */
    discount_minor: number;
    /** Server-computed regional tax at obligation time. */
    tax_minor: number;
    /** Selected shipping amount at obligation time. */
    shipping_minor: number;
    /** Embedded insurance premium at obligation time. */
    insurance_minor: number;
    status: PaymentState;
    metadata: JsonB;
    created_at: Generated<string>;
    updated_at: Generated<string>;
  };

  /**
   * domain/entities/Refund — durable, idempotent refund. Identified by
   * (provider_transaction_reference, amount_minor) so a refund can never be
   * issued twice, plus app-generated and provider refund references.
   */
  refund: {
    id: string;
    /** Optional link to the original payment intent (NULL for legacy rows). */
    payment_id: string | null;
    /** App-generated idempotency reference; unique. */
    refund_reference: string;
    /** Provider (Paystack) refund reference; unique when present. */
    provider_refund_reference: string | null;
    /** The provider transaction this refund targets. */
    provider_transaction_reference: string;
    amount_minor: number;
    currency: string | null;
    status: RefundStatus;
    reason: string | null;
    metadata: JsonB;
    created_at: Generated<string>;
    updated_at: Generated<string>;
  };

  /** domain/entities/OrderEdit */
  order_edit: {
    id: string;
    order_id: string;
    action_type: string;
    reason: string | null;
    /** Array of OrderEditChange snapshots; serialized JSONB. */
    proposed_changes: JsonB<OrderEditChange[]>;
    status: string;
    difference_due_minor: number;
    created_by: string | null;
    created_at: string | null;
    confirmed_by: string | null;
    confirmed_at: string | null;
    payment_reference: string | null;
  };

  /** domain/entities/Promotion. Code is normalized to uppercase and unique. */
  promotion: {
    id: string;
    code: string;
    discount_type: PromotionDiscountType;
    discount_value_minor: number;
    minimum_spend_minor: number;
    is_active: boolean;
  };

  // ---------------------------------------------------------------------------
  // Fulfillment, returns & swaps
  // ---------------------------------------------------------------------------

  /** FulfillmentRecord from domain/shared/contracts (dispatch + courier events). */
  fulfillment: {
    id: string;
    order_id: string;
    tracking_number: string;
    courier: string | null;
    label_url: string | null;
    service_level: string | null;
    status: string;
    metadata: JsonB;
    /**
     * Provider shipment identity (e.g. "SB-...") — first-class external
     * identity, NEVER the application orderId. Queryable for cancellation and
     * return-label flows.
     */
    provider_shipment_id: string | null;
    /**
     * L9 — the inventory_location node that actually fulfilled this order.
     * Resolves the shipment origin from the LOCAL location record (never
     * reconstructed from Shipbubble).
     */
    sourcing_location_id: string | null;
    created_at: Generated<string>;
    /** Set by courier tracking events (ProcessCourierTrackingEventUseCase). */
    updated_at: Generated<string>;
  };

  /** domain/entities/ReturnAuthorization (items are ReturnAuthorizationItem[]). */
  return_authorization: {
    id: string;
    order_id: string;
    /** [{lineItemId, quantity, reasonCode}] snapshots; serialized JSONB. */
    items: JsonB<ReturnAuthorizationItem[]>;
    refund_amount_minor: number;
    status: string;
    shipping_label_url: string | null;
    requested_by_customer_id: string | null;
    created_by: string;
    created_at: Generated<string>;
    metadata: JsonB;
    /**
     * Provider shipment identity of the RETURN label (e.g. "SB-...") — the
     * reverse-shipment identity, distinct from the outbound fulfillment's
     * provider_shipment_id. NEVER the application orderId.
     */
    provider_shipment_id: string | null;
  };

  /** domain/entities/Swap. */
  swap: {
    id: string;
    order_id: string;
    return_line_item_id: string;
    return_quantity: number;
    new_variant_id: string;
    new_variant_price_minor: number;
    original_value_minor: number;
    /** Signed variance: negative (customer refund) or positive (upcharge). */
    difference_minor: number;
    status: string;
    created_at: Generated<string>;
    created_by: string;
    payment_reference: string | null;
    payment_url: string | null;
    /**
     * Deterministic business identity of the swap request (order + line item +
     * target variant + quantity). UNIQUE so re-running the same swap request
     * collides instead of creating a duplicate swap/payment/refund.
     */
    natural_key: string | null;
  };

  // ---------------------------------------------------------------------------
  // B2B
  // ---------------------------------------------------------------------------

  /** domain/entities/Quote. Snapshot is the serialized cart (JSON string). */
  quote: {
    id: string;
    cart_id: string;
    cart_snapshot_json: string;
    business_unit_id: string;
    requested_by_customer_id: string;
    requested_at: Generated<string>;
    status: QuoteStatus;
    notes: string | null;
    approved_total_minor: number | null;
    approved_by: string | null;
    approved_at: string | null;
    approval_note: string | null;
  };

  /** BusinessUnitRecord from domain/shared/contracts. */
  business_unit: {
    id: string;
    name: string;
    registration_number: string;
    sales_channel_id: string;
    /** BusinessUnitMemberRecord[] member snapshots; serialized JSONB. */
    members: JsonB<BusinessUnitMemberRecord[]>;
    created_at: Generated<string>;
  };

  /** DraftOrderRecord from domain/shared/contracts. */
  draft_order: {
    id: string;
    email: string;
    /** DraftOrderItem[] line snapshots; serialized JSONB. */
    items: JsonB<DraftOrderItem[]>;
    shipping_address: JsonB | null;
    total_minor: number;
    status: string;
    created_by: string;
    created_at: Generated<string>;
    metadata: JsonB<{ createdByActor: string }>;
  };

  // ---------------------------------------------------------------------------
  // Community
  // ---------------------------------------------------------------------------

  /** Rows persisted via IReviewRepository. */
  review: {
    id: string;
    product_id: string;
    customer_id: string;
    rating: number;
    comment: string | null;
    created_at: Generated<string>;
  };

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  /**
   * Cross-cutting audit trail written by PostgresAuditLogService on behalf of
   * IAuditLogService.logAction. The actor is free-form text (admin id, customer
   * id, or the literal "system") — never a foreign key, since many events are
   * system-initiated. `details` is the caller-supplied StructuredMeta payload.
   */
  audit_log: {
    /** Application-generated text UUID (IIdGenerator); always supplied on insert. */
    id: string;
    /** Non-null actor identifier: the interface requires a non-empty string. */
    actor_id: string;
    /** Canonical action name, e.g. "PRODUCT_CREATE". */
    action: string;
    /** Action-specific structured payload; serialized JSONB. */
    details: JsonB;
    created_at: Generated<string>;
  };

  // ---------------------------------------------------------------------------
  // Notifications (L8)
  // ---------------------------------------------------------------------------

  /**
   * Durable notification outbox (migration 0014). One row per logical
   * notification, appended inside the producing use case's business
   * transaction; `EnqueuePendingNotificationsUseCase` relays pending rows to
   * `notification-events-queue` and drives the status lifecycle
   * pending -> queued -> dispatched | failed. `payload` is the full
   * provider-neutral `NotificationIntent`; `discriminator` disambiguates
   * per-occurrence intents (e.g. repeated courier tracking updates). A unique
   * index on (intent_type, aggregate_id, COALESCE(discriminator, '')) makes
   * duplicate appends collide.
   */
  notification_outbox: {
    /** Application-generated text UUID (IIdGenerator); always supplied. */
    id: string;
    intent_type: string;
    aggregate_id: string;
    discriminator: string | null;
    payload: JsonB<NotificationIntent>;
    status: string;
    attempts: number;
    last_error: string | null;
    job_id: string | null;
    provider_message_id: string | null;
    created_at: Generated<string>;
    updated_at: Generated<string>;
    dispatched_at: string | null;
  };
}
