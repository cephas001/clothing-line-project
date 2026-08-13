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
  PromotionSnapshot,
} from "@api/domain/shared/contracts";
import { FulfillmentStatus, PaymentStatus } from "@api/domain/entities/Order";
import { OrderEditChange } from "@api/domain/entities/OrderEdit";
import { PromotionDiscountType } from "@api/domain/entities/Promotion";
import { QuoteStatus } from "@api/domain/entities/Quote";
import { ReturnAuthorizationItem } from "@api/domain/entities/ReturnAuthorization";

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

  /** domain/entities/TaxCategory — rate in basis points. */
  tax_category: {
    id: string;
    name: string;
    region_id: string;
    rate: number;
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
     * Applied promotion snapshot (CartPromotionSnapshot: full config so a real
     * Promotion entity can be reconstructed on hydration); set via
     * applyDiscount().
     */
    discount: JsonB<CartPromotionSnapshot> | null;
    tax_amount_minor: number | null;
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
}
