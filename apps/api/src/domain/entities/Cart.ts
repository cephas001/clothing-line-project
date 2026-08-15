// apps/api/src/domain/entities/Cart.ts
import { CartLineItem } from "@api-domain-entities/CartLineItem";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import { Promotion } from "@api/domain/entities/Promotion";
import {
  PaymentAmountBreakdown,
  ShippingQuote,
} from "@api/domain/shared/contracts";
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
  /** Server-persisted selected shipping amount in minor units; null when unset. */
  shippingAmountMinor?: number | null;
  /** Server-persisted selected shipping service level. */
  shippingServiceLevel?: string | null;
  /**
   * Server-persisted provider request token from the rate response the selected
   * quote came from; required to create the shipment (two-phase label flow).
   */
  shippingRequestToken?: string | null;
  /** Server-persisted provider courier identity of the selected quote. */
  shippingCourierId?: string | null;
  /** Server-persisted provider service code of the selected quote. */
  shippingServiceCode?: string | null;
  /**
   * Application identity of the server-validated quote the client selected.
   * Part of the single shipping-selection invariant: present ONLY when the
   * whole selection is present.
   */
  shippingQuoteId?: string | null;
  /** Server-persisted ISO-4217 currency code of the selected quote. */
  shippingCurrency?: string | null;
  /**
   * Server-persisted quotes from the latest rate response (includes the provider
   * selection fields: courierId/serviceCode/requestToken; NEVER exposed to the
   * client). Selection resolves against this list so the authoritative amount
   * and currency ALWAYS come from a server-validated quote.
   */
  shippingQuotes?: ShippingQuote[];
  /**
   * Canonical fingerprint of the cart's material quote inputs (items, quantity,
   * price, weight metadata, destination, email, region context) captured when
   * {@link shippingQuotes} were recorded. A selection is valid ONLY while the
   * current cart computes the SAME fingerprint — otherwise the quote is stale.
   */
  shippingQuoteFingerprint?: string | null;
  /** Server-persisted insurance premium in minor units; null when not opted in. */
  insuranceAmountMinor?: number | null;
  /**
   * Optimistic-lock version. Persisted on the cart row and incremented by every
   * mutation (see {@link Cart.touch}); the repository guards its save against
   * the version the aggregate was loaded with so a stale concurrent writer is
   * rejected instead of silently overwriting state (L4 save/reset race).
   */
  version?: number;
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
  paymentReference?: string | null;
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
  public shippingAmountMinor: number | null;
  public shippingServiceLevel: string | null;
  public shippingRequestToken: string | null;
  public shippingCourierId: string | null;
  public shippingServiceCode: string | null;
  public shippingQuoteId: string | null;
  public shippingCurrency: string | null;
  public shippingQuoteFingerprint: string | null;
  public insuranceAmountMinor: number | null;
  /** Working optimistic-lock version; bumped by every mutation (touch). */
  public version: number;
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
  public paymentReference: string | null;

  // -------------------------
  // Private/internal state
  // -------------------------
  // Note: This collection is keyed by line item ID, not variant ID.
  private _items: Map<string, CartLineItem>;
  private _appliedPromotion: Promotion | null;
  private _shippingQuotes: ShippingQuote[];
  /**
   * The persisted version this aggregate was hydrated with (or 0 for a new
   * cart). The repository guards its conflict-update with this value, so a
   * stale writer fails with LOCKED instead of overwriting a concurrent change.
   */
  private _loadedVersion: number;

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
    this.shippingAmountMinor = props.shippingAmountMinor ?? null;
    this.shippingServiceLevel = props.shippingServiceLevel ?? null;
    this.shippingRequestToken = props.shippingRequestToken ?? null;
    this.shippingCourierId = props.shippingCourierId ?? null;
    this.shippingServiceCode = props.shippingServiceCode ?? null;
    this.shippingQuoteId = props.shippingQuoteId ?? null;
    this.shippingCurrency = props.shippingCurrency ?? null;
    this._shippingQuotes = Array.isArray(props.shippingQuotes)
      ? props.shippingQuotes
      : [];
    this.shippingQuoteFingerprint = props.shippingQuoteFingerprint ?? null;
    this.insuranceAmountMinor = props.insuranceAmountMinor ?? null;
    this.version = props.version ?? 0;
    this._loadedVersion = this.version;
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
    this.paymentReference = props.paymentReference ?? null;

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
    paymentReference?: string | null;
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
    this.paymentReference = metadata.paymentReference ?? null;
    this.paymentInitializedAt =
      metadata.initializedAt ?? new Date().toISOString();
    this.setMetadata("paymentInitialization", {
      authorizationUrl: this.paymentAuthorizationUrl,
      paymentReference: this.paymentReference,
      initializedAt: this.paymentInitializedAt,
    });
  }

  /**
   * clearPaymentInitialization
   * - Release the payment-initialization MIRROR on the cart (flag, status,
   *   authorization URL, reference and timestamp) when the durable payment
   *   obligation has been reset after a failed/abandoned attempt. Only the
   *   mirror is cleared — the durable Payment rows (including history) live in
   *   the payment repository and are never deleted here. Refuses to clear a
   *   paid or converted cart.
   */
  public clearPaymentInitialization(): void {
    if (this.paymentStatus === "paid") {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot clear payment state for a paid cart.",
      );
    }
    if (this.isConverted()) {
      throw new DomainError(
        "INVALID_OPERATION",
        "Cannot clear payment state for a converted cart.",
      );
    }

    this.paymentInitialized = false;
    this.paymentStatus = "pending";
    this.paymentAuthorizationUrl = null;
    this.paymentReference = null;
    this.paymentInitializedAt = null;
    const metadata = { ...this.metadata };
    delete metadata["paymentInitialization"];
    this.metadata = metadata;
    this.touch();
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
  // Authoritative money breakdown
  // -------------------------

  /**
   * applySelectedShippingQuote
   * - Persist a server-selected shipping quote on the cart: the amount (integer
   *   minor units), display service level, currency, and the provider selection
   *   needed to create the shipment later (courier identity, service code and
   *   the request token from the rate response). This is the ONLY writer of the
   *   durable shipping selection the checkout total and the dispatch flow
   *   trust — the client can never supply these directly, and the logistics
   *   adapter never chooses a courier itself.
   * - The selection MUST reference a quote in the server-persisted list
   *   ({@link recordShippingQuotes}); a stale or forged quoteId is rejected.
   */
  public applySelectedShippingQuote(props: {
    quoteId: string;
    courierId: string;
    serviceCode: string;
    requestToken: string;
    amountMinor: number;
    serviceLevel?: string | null;
    currency?: string | null;
    etaDays?: number | null;
  }): void {
    if (!Number.isInteger(props.amountMinor) || props.amountMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Shipping amount must be a non-negative integer in minor units.",
      );
    }
    if (!props.quoteId.trim() || !props.courierId.trim() || !props.serviceCode.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "A shipping quote selection requires a quote id, courier id and service code.",
      );
    }
    if (!props.requestToken.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "A shipping quote selection requires the provider request token.",
      );
    }
    // The authoritative amount/currency come from the persisted quote list;
    // applying a quote that is not in it would charge the client an un-validated
    // price.
    if (
      this._shippingQuotes.length > 0 &&
      !this.getShippingQuoteById(props.quoteId.trim())
    ) {
      throw new DomainError(
        "INVALID_STATE",
        "The selected shipping quote is not in the latest rate response; re-fetch quotes before selecting.",
      );
    }
    this.shippingQuoteId = props.quoteId.trim();
    this.shippingCurrency = props.currency?.trim() || null;
    this.shippingAmountMinor = props.amountMinor;
    this.shippingServiceLevel = props.serviceLevel?.trim() || null;
    this.shippingRequestToken = props.requestToken.trim();
    this.shippingCourierId = props.courierId.trim();
    this.shippingServiceCode = props.serviceCode.trim();
    this.touch();
  }

  /**
   * recordShippingQuotes
   * - Persist the server-validated quote list from the latest rate response on
   *   the cart (provider selection fields included; NEVER exposed to the
   *   client). Selection resolves against this list, so the authoritative
   *   amount and currency ALWAYS come from a server-validated quote.
   * - Replaces the previous list and keeps the shipping request token in sync.
   * - A selection is kept ONLY while the SAME quote (same id, amount and
   *   currency) is still present in the new list; otherwise the cart returns to
   *   the "no shipping selected" state so a stale or re-priced quote is never
   *   charged silently.
   * - Captures {@link shippingQuoteFingerprint} = the canonical fingerprint of
   *   THIS cart's material quote inputs at record time. A later selection (and
   *   the authoritative checkout calculation) is valid ONLY while the current
   *   cart computes the same fingerprint — so a mutated cart can never select
   *   or charge a quote obtained for a different cart state.
   */
  public recordShippingQuotes(quotes: ShippingQuote[]): void {
    const MAX_QUOTES = 50;
    const normalized = (Array.isArray(quotes) ? quotes : []).filter(
      (q) => Boolean(q && typeof q.id === "string" && q.id.trim() !== ""),
    ).slice(0, MAX_QUOTES);

    const previous = this.shippingQuoteId
      ? (this._shippingQuotes.find((q) => q.id === this.shippingQuoteId) ?? null)
      : null;

    this._shippingQuotes = normalized;

    if (normalized.length === 0) {
      this.clearShippingSelection();
      this.shippingRequestToken = null;
      this.shippingQuoteFingerprint = null;
    } else {
      this.shippingRequestToken = normalized[0].requestToken?.trim() || null;
      const current = this.shippingQuoteId
        ? normalized.find((q) => q.id === this.shippingQuoteId)
        : undefined;
      const unchanged =
        current !== undefined &&
        previous !== null &&
        current.amountMinor === previous.amountMinor &&
        (current.currency ?? null) === (previous.currency ?? null);
      if (!unchanged) {
        this.clearShippingSelection();
      }
      // The fingerprint is derived from the material quote inputs ONLY (items,
      // quantities, prices, weight metadata, destination, email, region
      // context), so it is stable across this shipping-state mutation itself.
      this.shippingQuoteFingerprint = this.computeQuoteContextFingerprint();
    }
    this.touch();
  }

  /**
   * shippingQuotes (getter)
   * - Array view of the server-persisted quote list from the latest rate
   *   response. Contains provider selection fields; callers MUST NOT expose
   *   them across the client boundary.
   */
  get shippingQuotes(): ShippingQuote[] {
    return [...this._shippingQuotes];
  }

  /**
   * getShippingQuoteById
   * - Resolve a full server-side quote (provider selection fields included) by
   *   its deterministic application id. Returns null when the quote is not in
   *   the persisted list (stale or unknown).
   */
  public getShippingQuoteById(quoteId: string): ShippingQuote | null {
    const id = (quoteId ?? "").trim();
    if (!id) {
      return null;
    }
    return this._shippingQuotes.find((q) => q.id === id) ?? null;
  }

  /**
   * computeQuoteContextFingerprint
   * - Canonical, deterministic fingerprint of the cart inputs that determine a
   *   shipping quote: the line items (id, variant, title, quantity, unit price,
   *   weight metadata), the destination address, the receiver email, and the
   *   region/sales-channel context. Property order is normalized and object
   *   keys are sorted recursively so the value is stable across persistence
   *   round-trips (Postgres jsonb reorders keys).
   * - Captured by {@link recordShippingQuotes}; compared by
   *   {@link isShippingQuoteCurrent}.
   */
  public computeQuoteContextFingerprint(): string {
    const items = this.items
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((item) => ({
        id: item.id,
        variantId: item.variantId ?? null,
        title: item.title ?? null,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        metadata: item.metadata ?? null,
      }));
    return canonicalJson({
      regionId: this.regionId,
      salesChannelId: this.salesChannelId,
      countryCode: this.countryCode ?? null,
      email: this.email ?? null,
      shippingAddress: this.shippingAddress ?? null,
      items,
    });
  }

  /**
   * isShippingQuoteCurrent
   * - True ONLY while the cart's material quote inputs are unchanged since
   *   {@link shippingQuotes} were recorded (i.e. the persisted fingerprint still
   *   matches the current cart). A selection is valid for "THIS cart state" and
   *   must be re-obtained after the cart changes.
   */
  public isShippingQuoteCurrent(): boolean {
    return Boolean(
      this.shippingQuoteFingerprint &&
        this.shippingQuoteFingerprint === this.computeQuoteContextFingerprint(),
    );
  }

  /**
   * isShippingSelectionConsistent
   * - Defense-in-depth: verifies the durable scalar selection fields agree with
   *   the server-persisted quote they claim to reference (amount, currency,
   *   courier, service, request token). A manipulated or partially-written
   *   selection therefore never becomes an authoritative charge.
   */
  public isShippingSelectionConsistent(): boolean {
    if (!this.hasShippingSelection) {
      return false;
    }
    const quote = this.shippingQuoteId
      ? this.getShippingQuoteById(this.shippingQuoteId)
      : null;
    if (!quote) {
      return false;
    }
    return (
      this.shippingAmountMinor === quote.amountMinor &&
      (this.shippingCurrency ?? null) === (quote.currency ?? null) &&
      this.shippingCourierId === quote.courierId &&
      this.shippingServiceCode === quote.serviceCode &&
      this.shippingRequestToken === quote.requestToken
    );
  }

  /**
   * hasShippingSelection (getter)
   * - The single source of truth distinguishing "shipping selected" from "no
   *   shipping selected". True ONLY when a complete, server-validated selection
   *   is present: the application quote identity, the provider courier/service
   *   identity and request token, and the durable amount + currency.
   */
  get hasShippingSelection(): boolean {
    return Boolean(
      this.shippingQuoteId &&
        this.shippingCourierId &&
        this.shippingServiceCode &&
        this.shippingRequestToken &&
        this.shippingAmountMinor !== null &&
        this.shippingAmountMinor >= 0 &&
        this.shippingCurrency,
    );
  }

  /**
   * clearShippingSelection
   * - Reset the cart to the "no shipping selected" state: quote identity,
   *   provider courier/service identity, request token, amount and currency are
   *   cleared. The shipping address and the persisted quote list are retained,
   *   so the client may select again without re-fetching quotes.
   */
  public clearShippingSelection(): void {
    this.shippingQuoteId = null;
    this.shippingCurrency = null;
    this.shippingAmountMinor = null;
    this.shippingServiceLevel = null;
    this.shippingRequestToken = null;
    this.shippingCourierId = null;
    this.shippingServiceCode = null;
    this.touch();
  }

  /**
   * recordShippingRequestToken
   * - Persist the provider request token from the latest rates response so the
   *   two-phase label flow can create the shipment later. Records the token
   *   only; the courier/service selection is recorded by
   *   {@link applySelectedShippingQuote}.
   */
  public recordShippingRequestToken(token: string): void {
    if (!token.trim()) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "A shipping request token is required.",
      );
    }
    this.shippingRequestToken = token.trim();
    this.touch();
  }

  /**
   * recordInsuranceQuote
   * - Persist a server-computed insurance premium on the cart (integer minor
   *   units). The premium is produced by the insurance service from the cart
   *   total, never supplied by the client.
   */
  public recordInsuranceQuote(premiumMinor: number): void {
    if (!Number.isInteger(premiumMinor) || premiumMinor < 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Insurance premium must be a non-negative integer in minor units.",
      );
    }
    this.insuranceAmountMinor = premiumMinor;
    this.touch();
  }

  /**
   * computeAuthoritativeCheckoutBreakdown
   * - Compute the ONE authoritative server-side financial breakdown for this
   *   cart: subtotal (Σ line totals) minus the applied promotion discount plus
   *   server-persisted tax, shipping, and insurance. Every component comes from
   *   server state (line prices set at add-time, Promotion config, persisted
   *   quotes) — nothing is trusted from the client.
   * - The shipping component is read from the DURABLE server-selected shipping
   *   state (`shippingAmountMinor`), which is written ONLY by
   *   {@link applySelectedShippingQuote} from a server-validated quote. Callers
   *   that turn this breakdown into a charge MUST first enforce that a shipping
   *   selection exists (`hasShippingSelection`), is current for this cart state
   *   (`isShippingQuoteCurrent`), and is internally consistent
   *   (`isShippingSelectionConsistent`) — see InitializePaymentSessionUseCase.
   * - All arithmetic is integer minor units; no floating-point math.
   */
  public computeAuthoritativeCheckoutBreakdown(): PaymentAmountBreakdown {
    const subtotalMinor = this.cartTotalMinor;
    const discountMinor = this.appliedPromotion
      ? this.appliedPromotion.computeDiscountAmount(subtotalMinor)
      : 0;
    const taxMinor = this.taxAmountMinor ?? 0;
    const shippingMinor = this.shippingAmountMinor ?? 0;
    const insuranceMinor = this.insuranceAmountMinor ?? 0;
    const totalMinor =
      subtotalMinor - discountMinor + taxMinor + shippingMinor + insuranceMinor;

    return {
      subtotalMinor,
      discountMinor,
      taxMinor,
      shippingMinor,
      insuranceMinor,
      totalMinor,
    };
  }

  /**
   * snapshotChargedLineItems
   * - Freeze the line items being charged (id, variantId, quantity,
   *   unitPriceMinor, title) so the finalized order reflects EXACTLY what was
   *   agreed at payment initialization, even if the cart mutates afterwards.
   */
  public snapshotChargedLineItems(): Array<{
    id: string;
    variantId: string | null;
    quantity: number;
    unitPriceMinor: number;
    title: string | null;
  }> {
    return this.items.map((item) => ({
      id: item.id,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      title: item.title ?? null,
    }));
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
    this.version = this.version + 1;
  }

  /**
   * loadedVersion
   * - The persisted version this aggregate was hydrated with; the repository
   *   guards its conflict-update against this value.
   */
  get loadedVersion(): number {
    return this._loadedVersion;
  }

  /**
   * acknowledgePersisted
   * - Called by the repository after a successful save/commit so the aggregate
   *   treats the just-written version as the new baseline. Fail-closed: if the
   *   surrounding transaction later rolls back, the next save compares against
   *   a version that no longer exists and is rejected (never a lost update).
   */
  public acknowledgePersisted(): void {
    this._loadedVersion = this.version;
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
      shippingAmountMinor: this.shippingAmountMinor,
      shippingServiceLevel: this.shippingServiceLevel,
      shippingRequestToken: this.shippingRequestToken,
      shippingCourierId: this.shippingCourierId,
      shippingServiceCode: this.shippingServiceCode,
      shippingQuoteId: this.shippingQuoteId,
      shippingCurrency: this.shippingCurrency,
      shippingQuoteFingerprint: this.shippingQuoteFingerprint,
      insuranceAmountMinor: this.insuranceAmountMinor,
      version: this.version,
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
      paymentReference: this.paymentReference,
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

/**
 * Deterministic JSON serialization: recursively sorts object keys and
 * normalizes null/undefined so the output is byte-stable regardless of key
 * insertion order or persistence round-trips (Postgres jsonb reorders keys).
 * Used by {@link Cart.computeQuoteContextFingerprint}.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
