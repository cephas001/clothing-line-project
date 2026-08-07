// apps/api/src/domain/entities/Cart.ts
import { CartLineItem } from "@api-domain-entities/CartLineItem";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Promotion } from "@api/domain/entities/Promotion";
import { JsonObject, JsonValue } from "@api/domain/shared/json";

export interface CartProps {
  id: string;
  regionId: string;
  salesChannelId: string;
  customerId?: string | null;
  email?: string | null;
  items?: CartLineItem[];
  appliedPromotion?: Promotion | null;
  createdAt?: string;
  countryCode?: string | null;
  currency?: string;
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

export class Cart {
  readonly id: string;
  readonly regionId: string;
  readonly salesChannelId: string;
  public customerId: string | null;
  public email: string | null;
  private _items: Map<string, CartLineItem>; // Mapped by Line Item ID for instant lookups
  private _appliedPromotion: Promotion | null;
  public createdAt: string;
  public countryCode: string | null;
  public currency: string;
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

  constructor(props: CartProps) {
    if (!props.regionId || !props.salesChannelId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Carts must be bound to a specific region and sales channel context.",
      );
    }

    this.id = props.id;
    this.regionId = props.regionId;
    this.salesChannelId = props.salesChannelId;
    this.customerId = props.customerId || null;
    this.email = props.email || null;
    this.createdAt = props.createdAt || new Date().toISOString();
    this.countryCode = props.countryCode || null;
    this.currency = props.currency || "NGN";
    this.shippingAddress = props.shippingAddress || null;
    this.taxAmountMinor = props.taxAmountMinor ?? null;
    this.metadata = props.metadata || {};
    this.frozen = props.frozen ?? false;
    this.frozenReason = props.frozenReason ?? null;
    this.frozenAt = props.frozenAt ?? null;
    this.orderId = props.orderId ?? null;
    this.convertedAt = props.convertedAt ?? null;
    this.status = props.status ?? "active";
    this.paymentStatus = props.paymentStatus ?? "pending";
    this.paymentInitialized = props.paymentInitialized ?? false;
    this.paymentAuthorizationUrl = props.paymentAuthorizationUrl ?? null;
    this.paymentInitializedAt = props.paymentInitializedAt ?? null;
    this._appliedPromotion = props.appliedPromotion || null;
    this._items = new Map();
    if (props.items) {
      props.items.forEach((item) => this._items.set(item.id, item));
    }
  }

  public addOrUpdateItem(item: CartLineItem): void {
    // This collection is keyed by line item ID, not variant ID.

    // If a line item with the same ID already exists, it is replaced.
    // Higher-level application logic can decide whether adding the same
    // product variant should merge quantities or create a new line item.
    this._items.set(item.id, item);
  }

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
  }

  public assignCustomer(customerId: string, email: string): void {
    if (!customerId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "customerId is required.");
    }
    this.customerId = customerId;
    this.email = email;
  }

  public setItems(items: CartLineItem[]): void {
    this._items.clear();
    items.forEach((item) => this._items.set(item.id, item));
  }

  public removeItem(lineItemId: string): void {
    this._items.delete(lineItemId);
  }

  get items(): CartLineItem[] {
    return Array.from(this._items.values());
  }

  get hasItems(): boolean {
    return this._items.size > 0;
  }

  public getItem(lineItemId: string): CartLineItem | undefined {
    return this._items.get(lineItemId);
  }

  get cartTotalMinor(): number {
    return this.items.reduce((total, item) => total + item.lineTotalMinor, 0);
  }

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

  applyDiscount(promotion: Promotion): void {
    this._appliedPromotion = promotion;
  }

  removeDiscount(): void {
    this._appliedPromotion = null;
  }

  get appliedPromotion(): Promotion | null {
    return this._appliedPromotion;
  }

  public setShippingAddress(address: JsonObject): void {
    this.shippingAddress = address;
  }

  public setMetadata(key: string, value: JsonValue): void {
    this.metadata = { ...this.metadata, [key]: value };
  }

  public markFrozen(props: { reason: string; frozenAt?: string }): void {
    const reason = props.reason.trim();
    if (!reason) {
      throw new DomainError("VALIDATION_ERROR", "reason is required.");
    }

    this.frozen = true;
    this.frozenReason = reason;
    this.frozenAt = props.frozenAt ?? new Date().toISOString();
  }

  public markConverted(props: { orderId: string; convertedAt?: string }): void {
    if (!props.orderId.trim()) {
      throw new DomainError("VALIDATION_ERROR", "orderId is required.");
    }

    this.orderId = props.orderId;
    this.convertedAt = props.convertedAt ?? new Date().toISOString();
    this.status = "converted";
  }

  public isConverted(): boolean {
    return Boolean(this.orderId || this.status === "converted");
  }

  public applyTax(taxAmountMinor: number): void {
    if (!Number.isInteger(taxAmountMinor) || taxAmountMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Tax amount must be a non-negative integer in minor units.",
      );
    }

    this.taxAmountMinor = taxAmountMinor;
  }

  public isPaymentInitialized(): boolean {
    return this.paymentInitialized;
  }

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

  public markPaid(props: { paidAt?: string }): void {
    this.paymentStatus = "paid";
    this.setMetadata("paymentPaidAt", props.paidAt ?? new Date().toISOString());
  }

  public toJSON(): JsonObject {
    return {
      id: this.id,
      regionId: this.regionId,
      salesChannelId: this.salesChannelId,
      customerId: this.customerId,
      email: this.email,
      createdAt: this.createdAt,
      countryCode: this.countryCode,
      currency: this.currency,
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
          }
        : null,
    };
  }
}
