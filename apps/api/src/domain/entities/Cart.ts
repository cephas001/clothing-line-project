// apps/api/src/domain/entities/Cart.ts
import { CartLineItem } from "@api-domain-entities/CartLineItem";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Promotion } from "@api/domain/entities/Promotion";
import { JsonObject, JsonValue } from "@api/domain/shared/json";

/**
 * CartProps
 * - Plain data shape used to construct a Cart entity.
 */
export interface CartProps {
  id: string;
  regionId: string;
  salesChannelId: string;
  customerId?: string | null;
  email?: string | null;
  items?: CartLineItem[];
  appliedPromotion?: Promotion | null;
  createdAt?: string;
  updatedAt?: string;
  countryCode?: string | null;
  shippingAddress?: JsonObject | null;
  taxAmountMinor?: number | null;
  metadata?: JsonObject;
  frozen?: boolean;
  frozenReason?: string | null;
  frozenAt?: string | null;
  orderId?: string | null;
  convertedAt?: string | null;
  status?: string;
  paymentStatus?: string;
  paymentInitialized?: boolean;
  paymentAuthorizationUrl?: string | null;
  paymentInitializedAt?: string | null;
}

/**
 * Cart
 *
 * Domain entity representing a shopping cart.
 * - Properties are grouped and documented for quick scanning.
 * - Methods are grouped by responsibility: item management, customer/payment,
 *   promotions, shipping/metadata, state transitions, serialization.
 */
export class Cart {
  // -------------------------
  // Readonly identity / context
  // -------------------------
  readonly id: string;
  readonly regionId: string;
  readonly salesChannelId: string;

  // -------------------------
  // Mutable public properties
  // -------------------------
  public customerId: string | null;
  public email: string | null;
  public createdAt: string;
  public updatedAt: string;
  public countryCode: string | null;
  public shippingAddress: JsonObject | null;
  public taxAmountMinor: number | null;
  public metadata: JsonObject;
  public frozen: boolean;
  public frozenReason: string | null;
  public frozenAt: string | null;
  public orderId: string | null;
  public convertedAt: string | null;
  public status: string;
  public paymentStatus: string;
  public paymentInitialized: boolean;
  public paymentAuthorizationUrl: string | null;
  public paymentInitializedAt: string | null;

  // -------------------------
  // Private/internal state
  // -------------------------
  // Note: This collection is keyed by line item ID, not variant ID.
  private _items: Map<string, CartLineItem>;
  private _appliedPromotion: Promotion | null;

  // -------------------------
  // Constructor
  // -------------------------
  constructor(props: CartProps) {
    // Domain validation: cart must be bound to region and sales channel.
    if (!props.regionId || !props.salesChannelId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Carts must be bound to a specific region and sales channel context.",
      );
    }

    // Identity / context
    this.id = props.id;
    this.regionId = props.regionId;
    this.salesChannelId = props.salesChannelId;

    // Basic customer/contact
    this.customerId = props.customerId || null;
    this.email = props.email || null;

    // Timestamps
    this.createdAt = props.createdAt || new Date().toISOString();
    this.updatedAt = props.updatedAt || new Date().toISOString();

    // Optional contextual fields
    this.countryCode = props.countryCode || null;
    this.shippingAddress = props.shippingAddress || null;
    this.taxAmountMinor = props.taxAmountMinor ?? null;
    this.metadata = props.metadata || {};

    // Lifecycle / state
    this.frozen = props.frozen ?? false;
    this.frozenReason = props.frozenReason ?? null;
    this.frozenAt = props.frozenAt ?? null;
    this.orderId = props.orderId ?? null;
    this.convertedAt = props.convertedAt ?? null;
    this.status = props.status ?? "active";

    // Payment state
    this.paymentStatus = props.paymentStatus ?? "pending";
    this.paymentInitialized = props.paymentInitialized ?? false;
    this.paymentAuthorizationUrl = props.paymentAuthorizationUrl ?? null;
    this.paymentInitializedAt = props.paymentInitializedAt ?? null;

    // Promotion and items
    this._appliedPromotion = props.appliedPromotion || null;
    this._items = new Map();
    if (props.items) {
      props.items.forEach((item) => this._items.set(item.id, item));
    }
  }

  // -------------------------
  // Item management
  // -------------------------

  /**
   * addOrUpdateItem
   * - Adds or replaces a line item keyed by the line item ID.
   * - Higher-level logic decides whether to merge by variant or create new lines.
   */
  public addOrUpdateItem(item: CartLineItem): void {
    // This collection is keyed by line item ID, not variant ID.
    // If a line item with the same ID already exists, it is replaced.
    this._items.set(item.id, item);
    this.touch();
  }

  /**
   * mergeItemsFrom
   * - Merge items from another cart into this one.
   * - Matching is done by variantId, unitPriceMinor, title and metadata equality.
   * - When matching, quantities are merged; otherwise a copy is added.
   */
  public mergeItemsFrom(source: Cart, generateId: () => string): void {
    for (const sourceItem of source.items) {
      const matchingItem = this.items.find(
        (item) =>
          item.variantId === sourceItem.variantId &&
          item.unitPriceMinor === sourceItem.unitPriceMinor &&
          item.title === sourceItem.title &&
          JSON.stringify(item.metadata) === JSON.stringify(sourceItem.metadata),
      );

      if (matchingItem) {
        matchingItem.updateQuantity(
          matchingItem.quantity + sourceItem.quantity,
        );
      } else {
        this.addOrUpdateItem(sourceItem.copyForCart(generateId(), this.id));
      }
    }
    this.touch();
  }

  /**
   * setItems
   * - Replace the entire set of line items.
   */
  public setItems(items: CartLineItem[]): void {
    this._items.clear();
    items.forEach((item) => this._items.set(item.id, item));
    this.touch();
  }

  /**
   * removeItem
   * - Remove a line item by its line item ID.
   */
  public removeItem(lineItemId: string): void {
    this._items.delete(lineItemId);
    this.touch();
  }

  /**
   * getItem
   * - Retrieve a single line item by ID.
   */
  public getItem(lineItemId: string): CartLineItem | undefined {
    return this._items.get(lineItemId);
  }

  /**
   * items (getter)
   * - Returns an array view of the internal Map for iteration and read-only operations.
   */
  get items(): CartLineItem[] {
    return Array.from(this._items.values());
  }

  /**
   * hasItems (getter)
   * - Quick boolean check whether the cart contains any items.
   */
  get hasItems(): boolean {
    return this._items.size > 0;
  }

  /**
   * cartTotalMinor (getter)
   * - Sum of all line totals in minor currency units.
   */
  get cartTotalMinor(): number {
    return this.items.reduce((total, item) => total + item.lineTotalMinor, 0);
  }

  /**
   * addCustomItem
   * - Convenience helper to add a custom (non-variant) line item.
   */
  public addCustomItem(customItem: {
    id: string;
    title: string;
    quantity: number;
    unitPriceMinor: number;
  }): void {
    const lineItem = new CartLineItem({
      id: customItem.id,
      cartId: this.id,
      variantId: null,
      quantity: customItem.quantity,
      unitPriceMinor: customItem.unitPriceMinor,
      metadata: { title: customItem.title },
      createdAt: new Date().toISOString(),
    });
    this.addOrUpdateItem(lineItem);
  }

  // -------------------------
  // Promotions
  // -------------------------

  /**
   * applyDiscount
   * - Attach a Promotion to the cart.
   */
  applyDiscount(promotion: Promotion): void {
    this._appliedPromotion = promotion;
    this.touch();
  }

  /**
   * removeDiscount
   * - Remove any applied promotion.
   */
  removeDiscount(): void {
    this._appliedPromotion = null;
    this.touch();
  }

  /**
   * appliedPromotion (getter)
   * - Expose the applied promotion (if any).
   */
  get appliedPromotion(): Promotion | null {
    return this._appliedPromotion;
  }

  // -------------------------
  // Shipping / metadata
  // -------------------------

  /**
   * setShippingAddress
   * - Set or replace the shipping address for the cart.
   */
  public setShippingAddress(address: JsonObject): void {
    this.shippingAddress = address;
    this.touch();
  }

  /**
   * setMetadata
   * - Merge a single metadata key/value into the cart metadata.
   */
  public setMetadata(key: string, value: JsonValue): void {
    this.metadata = { ...this.metadata, [key]: value };
    this.touch();
  }

  // -------------------------
  // Customer / payment related
  // -------------------------

  /**
   * assignCustomer
   * - Bind a customer to the cart and set the contact email.
   */
  public assignCustomer(customerId: string, email: string): void {
    if (!customerId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "customerId is required.");
    }
    this.customerId = customerId;
    this.email = email;
    this.touch();
  }

  /**
   * isPaymentInitialized
   * - Returns whether a payment session has been initialized for this cart.
   */
  public isPaymentInitialized(): boolean {
    return this.paymentInitialized;
  }

  /**
   * markPaymentInitialized
   * - Mark the cart as having an initialized payment session and persist metadata.
   * - Throws if payment was already initialized.
   */
  public markPaymentInitialized(metadata: {
    authorizationUrl?: string | null;
    initializedAt?: string;
  }): void {
    if (this.paymentInitialized) {
      throw new DomainError(
        "INVALID_STATE",
        "Payment session has already been initialized for this cart.",
      );
    }

    this.paymentInitialized = true;
    this.paymentStatus = "initialized";
    this.paymentAuthorizationUrl = metadata.authorizationUrl ?? null;
    this.paymentInitializedAt =
      metadata.initializedAt ?? new Date().toISOString();
    this.setMetadata("paymentInitialization", {
      authorizationUrl: this.paymentAuthorizationUrl,
      initializedAt: this.paymentInitializedAt,
    });
  }

  /**
   * markPaid
   * - Mark the cart as paid and record the timestamp in metadata.
   */
  public markPaid(props: { paidAt?: string }): void {
    this.paymentStatus = "paid";
    this.setMetadata("paymentPaidAt", props.paidAt ?? new Date().toISOString());
  }

  // -------------------------
  // Lifecycle / state transitions
  // -------------------------

  /**
   * markFrozen
   * - Mark the cart as frozen to prevent modifications (e.g., during quote processing).
   */
  public markFrozen(props: { reason: string; frozenAt?: string }): void {
    const reason = props.reason.trim();
    if (!reason) {
      throw new DomainError("VALIDATION_ERROR", "reason is required.");
    }

    this.frozen = true;
    this.frozenReason = reason;
    this.frozenAt = props.frozenAt ?? new Date().toISOString();
    this.touch();
  }

  /**
   * markConverted
   * - Mark the cart as converted into an order and attach the orderId.
   */
  public markConverted(props: { orderId: string; convertedAt?: string }): void {
    if (!props.orderId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }

    this.orderId = props.orderId;
    this.convertedAt = props.convertedAt ?? new Date().toISOString();
    this.status = "converted";
    this.touch();
  }

  /**
   * isConverted
   * - Check whether the cart has been converted to an order.
   */
  public isConverted(): boolean {
    return Boolean(this.orderId || this.status === "converted");
  }

  /**
   * applyTax
   * - Apply a tax amount in minor currency units; must be a non-negative integer.
   */
  public applyTax(taxAmountMinor: number): void {
    if (!Number.isInteger(taxAmountMinor) || taxAmountMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax amount must be a non-negative integer in minor units.",
      );
    }

    this.taxAmountMinor = taxAmountMinor;
    this.touch();
  }

  // -------------------------
  // Utilities
  // -------------------------

  /**
   * touch
   * - Update the updatedAt timestamp to the current time.
   * - Called by mutating operations to keep the entity consistent.
   */
  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }

  // -------------------------
  // Serialization
  // -------------------------

  /**
   * toJSON
   * - Return a JSON-serializable representation of the cart suitable for persistence
   *   or snapshotting (e.g., for quote creation).
   */
  public toJSON(): JsonObject {
    return {
      id: this.id,
      regionId: this.regionId,
      salesChannelId: this.salesChannelId,
      customerId: this.customerId,
      email: this.email,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      countryCode: this.countryCode,
      shippingAddress: this.shippingAddress,
      taxAmountMinor: this.taxAmountMinor,
      metadata: this.metadata,
      frozen: this.frozen,
      frozenReason: this.frozenReason,
      frozenAt: this.frozenAt,
      orderId: this.orderId,
      convertedAt: this.convertedAt,
      status: this.status,
      paymentStatus: this.paymentStatus,
      paymentInitialized: this.paymentInitialized,
      paymentAuthorizationUrl: this.paymentAuthorizationUrl,
      paymentInitializedAt: this.paymentInitializedAt,
      items: this.items.map((item) => ({
        id: item.id,
        cartId: item.cartId,
        variantId: item.variantId,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        metadata: item.metadata,
        createdAt: item.createdAt,
        title: item.title,
      })),
      appliedPromotion: this.appliedPromotion
        ? {
            id: this.appliedPromotion.id,
            code: this.appliedPromotion.code,
            discountType: this.appliedPromotion.discountType,
            discountValueMinor: this.appliedPromotion.discountValueMinor,
            minimumSpendMinor: this.appliedPromotion.minimumSpendMinor,
            isActive: this.appliedPromotion.isActive,
          }
        : null,
    };
  }
}
