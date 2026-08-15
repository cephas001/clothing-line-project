// apps/api/src/domain/entities/Order.ts

import { DomainError } from "@api/domain/entities/errors/DomainError";
import { OrderShippingSnapshot, PromotionSnapshot } from "@api/domain/shared/contracts";
import { JsonObject } from "@api/domain/shared/json";

/**
 * Domain types used by Order
 */
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

/**
 * OrderLineItem
 * - Minimal snapshot of a purchased line on an order.
 */
export interface OrderLineItem {
  id: string;
  variantId?: string | null;
  quantity: number;
  unitPriceMinor: number;
  fulfilledQuantity?: number | null;
}

/**
 * ProposedChangeType
 * - Used when proposing or applying edits to an order.
 */
export interface ProposedChangeType {
  type: "add" | "remove" | "update";
  lineItemId?: string | null;
  newVariantId?: string | null;
  quantity: number;
  unitPriceMinor?: number;
}

/**
 * OrderProps
 * - Plain data shape used to construct an Order entity.
 */
export interface OrderProps {
  id: string;
  cartId: string;
  customerId: string;
  totalAmountMinor: number;
  /** ISO-4217 currency code (lowercase) of the captured charge. */
  currency?: string | null;
  /** Frozen subtotal (Σ line totals) at order time, in minor units. */
  subtotalMinor?: number;
  /** Frozen promotion discount at order time, in minor units. */
  discountMinor?: number;
  /** Frozen regional tax at order time, in minor units. */
  taxMinor?: number;
  /** Frozen shipping amount at order time, in minor units. */
  shippingMinor?: number;
  /** Frozen insurance premium at order time, in minor units. */
  insuranceMinor?: number;
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
  /**
   * Frozen provider-neutral shipping snapshot (destination, parcel items,
   * selected quote, request_token) recorded at checkout so the dispatch and
   * return flows are self-contained and never depend on the mutable cart.
   */
  shippingSnapshot?: OrderShippingSnapshot | null;
}

/**
 * Order
 *
 * Domain entity representing a finalized order snapshot.
 * - Keeps an immutable financial baseline (_totalAmountMinor) and exposes
 *   methods to mutate fulfillment/payment state and apply edits.
 * - All monetary values are integers in minor units (Kobo).
 * - The financial snapshot (currency, subtotal, discount, tax, shipping,
 *   insurance) is FROZEN at checkout from the durable payment obligation — the
 *   order never depends on today's product prices, regional pricing,
 *   promotions, or taxes to reconstruct what the customer agreed to pay.
 */
export class Order {
  // -------------------------
  // Identity and baseline
  // -------------------------
  readonly id: string;
  readonly cartId: string;
  readonly customerId: string;
  private _totalAmountMinor: number; // Immutable financial baseline
  public readonly createdAt: string;

  // -------------------------
  // Frozen financial snapshot
  // -------------------------
  public readonly currency: string | null;
  private readonly _subtotalMinor: number;
  private readonly _discountMinor: number;
  private readonly _taxMinor: number;
  private readonly _shippingMinor: number;
  private readonly _insuranceMinor: number;

  // -------------------------
  // State machines
  // -------------------------
  private _fulfillmentStatus: FulfillmentStatus;
  private _paymentStatus: PaymentStatus;

  // -------------------------
  // Payment / risk / flags
  // -------------------------
  public transactionReference: string | null;
  public paymentStatusReason: string | null;
  public paymentStatusUpdatedAt: string | null;
  public flaggedForReview: boolean;
  public flagReason: string | null;
  public riskScore: number | null;
  public flaggedAt: string | null;
  public fulfillmentHaltedAt: string | null;

  // -------------------------
  // Collections and snapshots
  // -------------------------
  private _lineItems: OrderLineItem[];
  private _availableVariants: Array<{ id: string; unitPriceMinor: number }>;
  private _fulfillments: JsonObject[];
  private _pendingReturns: JsonObject[];
  public promotionSnapshot: PromotionSnapshot | null;
  public shippingSnapshot: OrderShippingSnapshot | null;

  // -------------------------
  // Constructor and validation
  // -------------------------
  constructor(props: OrderProps) {
    // Domain invariants
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

    // Identity / baseline
    this.id = props.id;
    this.cartId = props.cartId;
    this.customerId = props.customerId;
    this._totalAmountMinor = props.totalAmountMinor;
    this.createdAt = props.createdAt || new Date().toISOString();

    // Frozen financial snapshot (defaults preserve legacy/pre-foundation rows).
    this.currency = props.currency ?? null;
    this._subtotalMinor = props.subtotalMinor ?? props.totalAmountMinor;
    this._discountMinor = props.discountMinor ?? 0;
    this._taxMinor = props.taxMinor ?? 0;
    this._shippingMinor = props.shippingMinor ?? 0;
    this._insuranceMinor = props.insuranceMinor ?? 0;

    for (const [label, value] of [
      ["subtotalMinor", this._subtotalMinor],
      ["discountMinor", this._discountMinor],
      ["taxMinor", this._taxMinor],
      ["shippingMinor", this._shippingMinor],
      ["insuranceMinor", this._insuranceMinor],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `Order ${label} must be a non-negative integer in minor units.`,
        );
      }
    }

    // Initial states
    this._fulfillmentStatus = props.fulfillmentStatus || "unfulfilled";
    this._paymentStatus = props.paymentStatus || "pending";

    // Payment / risk / flags
    this.transactionReference = props.transactionReference ?? null;
    this.paymentStatusReason = props.paymentStatusReason ?? null;
    this.paymentStatusUpdatedAt = props.paymentStatusUpdatedAt ?? null;
    this.flaggedForReview = props.flaggedForReview ?? false;
    this.flagReason = props.flagReason ?? null;
    this.riskScore = props.riskScore ?? null;
    this.flaggedAt = props.flaggedAt ?? null;
    this.fulfillmentHaltedAt = props.fulfillmentHaltedAt ?? null;

    // Collections (defensive copies)
    this._lineItems = props.lineItems ? [...props.lineItems] : [];
    this._availableVariants = props.availableVariants
      ? [...props.availableVariants]
      : [];
    this._fulfillments = props.fulfillments ? [...props.fulfillments] : [];
    this._pendingReturns = props.pendingReturns
      ? [...props.pendingReturns]
      : [];
    this.promotionSnapshot = props.promotionSnapshot ?? null;
    this.shippingSnapshot = props.shippingSnapshot ?? null;
  }

  // -------------------------
  // Fulfillment state machine
  // -------------------------

  /**
   * markAsFulfilled
   * - Transition the order to fulfilled.
   * - Guard: cannot fulfill an order that has been marked returned.
   */
  public markAsFulfilled(): void {
    if (this._fulfillmentStatus === "returned") {
      throw new DomainError(
        "INVALID_STATE",
        "Cannot fulfill a returned order.",
      );
    }
    this._fulfillmentStatus = "fulfilled";
  }

  /**
   * processReturn
   * - Mark the order as returned (used when returns complete).
   */
  public processReturn(): void {
    this._fulfillmentStatus = "returned";
  }

  /**
   * setFulfillmentStatus
   * - Generic setter for fulfillment status with domain guard for returned -> fulfilled.
   */
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

  /**
   * haltFulfillment
   * - Place the order on hold and record when it was halted.
   */
  public haltFulfillment(props?: { reason?: string; haltedAt?: string }): void {
    this._fulfillmentStatus = "on_hold";
    this.fulfillmentHaltedAt = props?.haltedAt ?? new Date().toISOString();
  }

  /**
   * addFulfillment
   * - Append a fulfillment record and mark order as fulfilled.
   * - Validates the fulfillment payload shape minimally.
   */
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

  // -------------------------
  // Returns handling
  // -------------------------

  /**
   * markReturnPending
   * - Mark a line item as having a pending return.
   * - Validates line existence and that requested quantity does not exceed fulfilled quantity.
   */
  public markReturnPending(lineItemId: string, quantity: number): void {
    const line = this._lineItems.find((li) => li.id === lineItemId);
    if (!line) {
      throw new DomainError(
        "INVALID_RETURN_ITEM",
        "Line item not found on order.",
      );
    }
    const fulfilledQty = line.fulfilledQuantity ?? line.quantity;
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > fulfilledQty
    ) {
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

  // -------------------------
  // Payment state machine & risk
  // -------------------------

  /**
   * setPaymentStatus
   * - Update payment status and optional reason/timestamp.
   * - No-op if status is unchanged.
   */
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

  /**
   * flagForReview
   * - Mark the order for manual review with a reason and optional score.
   */
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

  // -------------------------
  // Promotion snapshot
  // -------------------------

  /**
   * recordPromotionSnapshot
   * - Persist an immutable snapshot of the promotion applied at order time.
   * - Validates minimal required fields on the snapshot.
   */
  public recordPromotionSnapshot(snapshot: PromotionSnapshot): void {
    if (!snapshot || !snapshot.promotionId || !snapshot.code) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Promotion snapshot must include promotionId and code.",
      );
    }
    this.promotionSnapshot = snapshot;
  }

  // -------------------------
  // Financial helpers
  // -------------------------

  /**
   * calculateProratedValue
   * - Compute the prorated monetary value for a returned quantity of a line item.
   * - Uses unitPriceMinor * quantity as the fallback/prorated calculation.
   */
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

  /**
   * calculateEditVariance
   * - Compute the integer minor-currency variance for a set of proposed changes.
   * - Uses availableVariants to resolve prices for added/updated variants.
   */
  public calculateEditVariance(changes: ProposedChangeType[]): number {
    let variance = 0;
    for (const ch of changes) {
      if (ch.type === "add") {
        const variant = this._availableVariants.find(
          (v) => String(v.id) === String(ch.newVariantId),
        );
        const price = variant ? Math.floor(Number(variant.unitPriceMinor)) : 0;
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

  /**
   * applyConfirmedEdits
   * - Apply a set of confirmed changes to the order's line items and recalculate totals.
   * - Validates appliedBy and delegates to recalculateTotals after mutation.
   */
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

  /**
   * recalculateTotals
   * - Recompute the order's total amount from current line items.
   * - Ensures the internal baseline remains an integer in minor units.
   */
  public recalculateTotals(): void {
    this._totalAmountMinor = this._lineItems.reduce(
      (sum, li) => sum + li.unitPriceMinor * li.quantity,
      0,
    );
  }

  /**
   * applySwap
   * - Apply a confirmed swap to the order's line items and adjust the total.
   * - The returned quantity is removed from the existing line (or the whole
   *   line when fully returned) and a replacement line is added for the new
   *   variant at its frozen unit price.
   * - The total is adjusted ONLY by the swap variance (original value removed,
   *   replacement value added), preserving the order's frozen financial
   *   structure (discount/tax/shipping/insurance are not recomputed).
   * - Validates that the returned quantity does not exceed the line quantity.
   */
  public applySwap(props: {
    returnLineItemId: string;
    returnQuantity: number;
    newVariantId: string;
    unitPriceMinor: number;
    appliedBy: string;
    appliedAt: string;
  }): void {
    if (!props.appliedBy || props.appliedBy.trim() === "") {
      throw new DomainError("VALIDATION_ERROR", "appliedBy is required.");
    }
    const line = this._lineItems.find(
      (li) => li.id === props.returnLineItemId,
    );
    if (!line) {
      throw new DomainError(
        "INVALID_RETURN_ITEM",
        "Line item not found on order.",
      );
    }
    if (
      !Number.isInteger(props.returnQuantity) ||
      props.returnQuantity < 1 ||
      props.returnQuantity > line.quantity
    ) {
      throw new DomainError(
        "INVALID_RETURN_QUANTITY",
        "Cannot swap more items than were ordered on the line.",
      );
    }
    if (!Number.isInteger(props.unitPriceMinor) || props.unitPriceMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Replacement unit price must be a non-negative integer in minor units.",
      );
    }

    const originalValueMinor = Math.floor(
      line.unitPriceMinor * props.returnQuantity,
    );
    const newValueMinor = Math.floor(props.unitPriceMinor * props.returnQuantity);

    const remaining = line.quantity - props.returnQuantity;
    if (remaining <= 0) {
      this._lineItems = this._lineItems.filter(
        (li) => li.id !== line.id,
      );
    } else {
      line.quantity = remaining;
    }

    this._lineItems.push({
      id: `${line.id}-swap-${props.newVariantId}`,
      variantId: props.newVariantId,
      quantity: props.returnQuantity,
      unitPriceMinor: props.unitPriceMinor,
    });

    this._totalAmountMinor =
      this._totalAmountMinor - originalValueMinor + newValueMinor;
  }

  // -------------------------
  // Read-only accessors
  // -------------------------

  get fulfillmentStatus(): FulfillmentStatus {
    return this._fulfillmentStatus;
  }

  get paymentStatus(): PaymentStatus {
    return this._paymentStatus;
  }

  get totalAmountMinor(): number {
    return this._totalAmountMinor;
  }

  get subtotalMinor(): number {
    return this._subtotalMinor;
  }

  get discountMinor(): number {
    return this._discountMinor;
  }

  get taxMinor(): number {
    return this._taxMinor;
  }

  get shippingMinor(): number {
    return this._shippingMinor;
  }

  get insuranceMinor(): number {
    return this._insuranceMinor;
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
