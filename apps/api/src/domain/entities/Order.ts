// apps/api/src/domain/entities/Order.ts
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { PromotionSnapshot } from "@api/domain/shared/contracts";
import { JsonObject } from "@api/domain/shared/json";

export type FulfillmentStatus =
  | "unfulfilled"
  | "ready_for_dispatch"
  | "partially_fulfilled"
  | "fulfilled"
  | "returned"
  | "on_hold";

export type PaymentStatus =
  | "pending"
  | "captured"
  | "failed"
  | "requires_action"
  | "on_hold";

export interface OrderLineItem {
  id: string;
  variantId?: string | null;
  quantity: number;
  unitPriceMinor: number;
  fulfilledQuantity?: number | null;
}

export interface ProposedChangeType {
  type: "add" | "remove" | "update";
  lineItemId?: string | null;
  newVariantId?: string | null;
  quantity: number;
  unitPriceMinor?: number;
}

export interface OrderProps {
  id: string;
  cartId: string;
  customerId: string;
  totalAmountMinor: number;
  fulfillmentStatus?: FulfillmentStatus;
  paymentStatus?: PaymentStatus;
  transactionReference?: string | null;
  paymentStatusReason?: string | null;
  paymentStatusUpdatedAt?: string | null;
  flaggedForReview?: boolean;
  flagReason?: string | null;
  riskScore?: number | null;
  flaggedAt?: string | null;
  fulfillmentHaltedAt?: string | null;
  lineItems?: OrderLineItem[];
  availableVariants?: Array<{ id: string; unitPriceMinor: number }>;
  fulfillments?: JsonObject[];
  pendingReturns?: JsonObject[];
  createdAt?: string;
  promotionSnapshot?: PromotionSnapshot | null;
}

export class Order {
  readonly id: string;
  readonly cartId: string;
  readonly customerId: string;
  private _totalAmountMinor: number; // Immutable financial baseline
  private _fulfillmentStatus: FulfillmentStatus;
  private _paymentStatus: PaymentStatus;
  public transactionReference: string | null;
  public paymentStatusReason: string | null;
  public paymentStatusUpdatedAt: string | null;
  public flaggedForReview: boolean;
  public flagReason: string | null;
  public riskScore: number | null;
  public flaggedAt: string | null;
  public fulfillmentHaltedAt: string | null;
  public readonly createdAt: string;
  private _lineItems: OrderLineItem[];
  private _availableVariants: Array<{ id: string; unitPriceMinor: number }>;
  private _fulfillments: JsonObject[];
  private _pendingReturns: JsonObject[];
  public promotionSnapshot: PromotionSnapshot | null;

  constructor(props: OrderProps) {
    if (!props.cartId || !props.customerId) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Orders must be permanently linked to a valid cart and customer.",
      );
    }
    if (
      !Number.isInteger(props.totalAmountMinor) ||
      props.totalAmountMinor < 0
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Order totals must be strictly normalized integers in Kobo.",
      );
    }

    this.id = props.id;
    this.cartId = props.cartId;
    this.customerId = props.customerId;
    this._totalAmountMinor = props.totalAmountMinor;
    this._fulfillmentStatus = props.fulfillmentStatus || "unfulfilled";
    this._paymentStatus = props.paymentStatus || "pending";
    this.transactionReference = props.transactionReference ?? null;
    this.paymentStatusReason = props.paymentStatusReason ?? null;
    this.paymentStatusUpdatedAt = props.paymentStatusUpdatedAt ?? null;
    this.flaggedForReview = props.flaggedForReview ?? false;
    this.flagReason = props.flagReason ?? null;
    this.riskScore = props.riskScore ?? null;
    this.flaggedAt = props.flaggedAt ?? null;
    this.fulfillmentHaltedAt = props.fulfillmentHaltedAt ?? null;
    this.createdAt = props.createdAt || new Date().toISOString();
    this._lineItems = props.lineItems ? [...props.lineItems] : [];
    this._availableVariants = props.availableVariants
      ? [...props.availableVariants]
      : [];
    this._fulfillments = props.fulfillments ? [...props.fulfillments] : [];
    this._pendingReturns = props.pendingReturns
      ? [...props.pendingReturns]
      : [];
    this.promotionSnapshot = props.promotionSnapshot ?? null;
  }

  // --- Fulfillment state machine
  public markAsFulfilled(): void {
    if (this._fulfillmentStatus === "returned") {
      throw new DomainError(
        "INVALID_STATE",
        "Cannot fulfill a returned order.",
      );
    }
    this._fulfillmentStatus = "fulfilled";
  }

  public processReturn(): void {
    this._fulfillmentStatus = "returned";
  }

  public setFulfillmentStatus(
    status: FulfillmentStatus,
    props?: { updatedAt?: string },
  ): void {
    if (status === "fulfilled" && this._fulfillmentStatus === "returned") {
      throw new DomainError(
        "INVALID_STATE",
        "Cannot fulfill a returned order.",
      );
    }
    this._fulfillmentStatus = status;
  }

  // --- Payment state machine
  public setPaymentStatus(
    status: PaymentStatus,
    props?: { reason?: string; updatedAt?: string },
  ): void {
    if (status === this._paymentStatus) {
      return;
    }
    this._paymentStatus = status;
    this.paymentStatusReason = props?.reason ?? this.paymentStatusReason;
    this.paymentStatusUpdatedAt = props?.updatedAt ?? new Date().toISOString();
  }

  public flagForReview(props: {
    reason: string;
    score?: number;
    flaggedAt?: string;
  }): void {
    if (!props.reason || props.reason.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "flag reason is required.");
    }
    this.flaggedForReview = true;
    this.flagReason = props.reason;
    this.riskScore = props.score ?? this.riskScore;
    this.flaggedAt = props.flaggedAt ?? new Date().toISOString();
  }

  public haltFulfillment(props?: { reason?: string; haltedAt?: string }): void {
    this._fulfillmentStatus = "on_hold";
    this.fulfillmentHaltedAt = props?.haltedAt ?? new Date().toISOString();
  }

  public addFulfillment(fulfillment: JsonObject): void {
    if (!fulfillment || typeof fulfillment !== "object") {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Fulfillment must be a valid object.",
      );
    }
    this._fulfillments.push(fulfillment);
    this._fulfillmentStatus = "fulfilled";
  }

  public markReturnPending(lineItemId: string, quantity: number): void {
    const line = this._lineItems.find((li) => li.id === lineItemId);
    if (!line) {
      throw new DomainError(
        "INVALID_RETURN_ITEM",
        "Line item not found on order.",
      );
    }
    const fulfilledQty = line.fulfilledQuantity ?? line.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > fulfilledQty) {
      throw new DomainError(
        "INVALID_RETURN_QUANTITY",
        "Cannot return more items than were fulfilled.",
      );
    }
    this._pendingReturns.push({
      lineItemId,
      quantity,
      returnedAt: new Date().toISOString(),
    });
  }

  // --- Promotion snapshot (historically immutable)
  public recordPromotionSnapshot(snapshot: PromotionSnapshot): void {
    if (!snapshot || !snapshot.promotionId || !snapshot.code) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Promotion snapshot must include promotionId and code.",
      );
    }
    this.promotionSnapshot = snapshot;
  }

  // --- Financial helpers
  public calculateProratedValue(lineItemId: string, quantity: number): number {
    const line = this._lineItems.find((li) => li.id === lineItemId);
    if (!line) {
      throw new DomainError(
        "INVALID_RETURN_ITEM",
        "Line item not found on order.",
      );
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Quantity must be a positive integer.",
      );
    }
    return Math.floor(line.unitPriceMinor * quantity);
  }

  public calculateEditVariance(changes: ProposedChangeType[]): number {
    let variance = 0;
    for (const ch of changes) {
      if (ch.type === "add") {
        const variant = this._availableVariants.find(
          (v) => String(v.id) === String(ch.newVariantId),
        );
        const price = variant
          ? Math.floor(Number(variant.unitPriceMinor))
          : 0;
        variance += price * Math.floor(Number(ch.quantity));
      } else if (ch.type === "remove") {
        const line = this._lineItems.find(
          (li) => String(li.id) === String(ch.lineItemId),
        );
        const price = line ? Math.floor(Number(line.unitPriceMinor)) : 0;
        variance -= price * Math.floor(Number(ch.quantity));
      } else if (ch.type === "update") {
        const line = this._lineItems.find(
          (li) => String(li.id) === String(ch.lineItemId),
        );
        const oldPrice = line ? Math.floor(Number(line.unitPriceMinor)) : 0;
        const newVariant = this._availableVariants.find(
          (v) => String(v.id) === String(ch.newVariantId),
        );
        const newPrice = newVariant
          ? Math.floor(Number(newVariant.unitPriceMinor))
          : oldPrice;
        variance += (newPrice - oldPrice) * Math.floor(Number(ch.quantity));
      }
    }
    return variance;
  }

  public applyConfirmedEdits(
    changes: ProposedChangeType[],
    props: { appliedBy: string; appliedAt: string },
  ): void {
    if (!props.appliedBy || props.appliedBy.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "appliedBy is required.");
    }
    for (const ch of changes) {
      if (ch.type === "add") {
        this._lineItems.push({
          id: ch.lineItemId ?? new Date().getTime().toString(),
          variantId: ch.newVariantId ?? null,
          quantity: Math.floor(Number(ch.quantity)),
          unitPriceMinor: Math.floor(Number(ch.unitPriceMinor ?? 0)),
        });
      } else if (ch.type === "remove") {
        this._lineItems = this._lineItems.filter(
          (li) => String(li.id) !== String(ch.lineItemId),
        );
      } else if (ch.type === "update") {
        const line = this._lineItems.find(
          (li) => String(li.id) === String(ch.lineItemId),
        );
        if (line) {
          if (ch.newVariantId) line.variantId = ch.newVariantId;
          if (typeof ch.quantity !== "undefined")
            line.quantity = Math.floor(Number(ch.quantity));
          if (typeof ch.unitPriceMinor !== "undefined")
            line.unitPriceMinor = Math.floor(Number(ch.unitPriceMinor));
        }
      }
    }
    this.recalculateTotals();
  }

  public recalculateTotals(): void {
    this._totalAmountMinor = this._lineItems.reduce(
      (sum, li) => sum + li.unitPriceMinor * li.quantity,
      0,
    );
  }

  get fulfillmentStatus(): FulfillmentStatus {
    return this._fulfillmentStatus;
  }

  get paymentStatus(): PaymentStatus {
    return this._paymentStatus;
  }

  get totalAmountMinor(): number {
    return this._totalAmountMinor;
  }

  get lineItems(): OrderLineItem[] {
    return [...this._lineItems];
  }

  get availableVariants(): Array<{ id: string; unitPriceMinor: number }> {
    return [...this._availableVariants];
  }

  get fulfillments(): JsonObject[] {
    return [...this._fulfillments];
  }

  get pendingReturns(): JsonObject[] {
    return [...this._pendingReturns];
  }
}