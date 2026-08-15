// apps/api/src/infrastructure/services/ShipbubbleLogisticsService.ts

// Infrastructure implementation of ILogisticsService backed by the Shipbubble
// HTTP API (https://docs.shipbubble.com). This is the ONLY module that knows
// Shipbubble exists. Domain/application code never imports it and never sees
// its request or response shapes; they only ever talk to the ILogisticsService
// contract.
//
// Verified provider contract (docs.shipbubble.com, retrieved for this task):
//   - Base URL:            https://api.shipbubble.com/v1
//   - Authentication:      "Authorization: Bearer <API_KEY>" on every request.
//                          Sandbox keys start "sb_sandbox_", live keys "sb_prod_".
//   - Envelope:            { status: "success"|"failed", message, data, errors }.
//                          `status === "success"` is the ONLY application-level
//                          success; a resolved fetch alone is never success.
//   - Validate address:    POST /v1/shipping/address/validate  { name, email,
//                          phone, address } -> data.address_code (int). Address
//                          codes uniquely identify verified addresses and are
//                          REQUIRED (as sender_address_code /
//                          reciever_address_code) by the rates API.
//   - Request rates:       POST /v1/shipping/fetch_rates      { sender_address_code,
//                          reciever_address_code, pickup_date, category_id,
//                          package_items: [{ name, description, unit_weight,
//                          unit_amount, quantity }], package_dimension: {
//                          length, width, height } } -> data.request_token +
//                          data.couriers[] ({ courier_id, service_code,
//                          rate_card_amount, rate_card_currency, currency, vat,
//                          total, delivery_eta_time, ... }).
//   - Create shipment:     POST /v1/shipping/labels            { request_token,
//                          service_code, courier_id, insurance_code?,
//                          is_cod_label? } -> data.order_id (provider id),
//                          data.tracking_url. The tracking number
//                          (courier.tracking_code) and the waybill/label
//                          document URL (waybill_document) are NOT in the create
//                          response; they are available on the shipment records
//                          via GET /v1/shipping/labels/list/:order_ids.
//   - Cancel shipment:     POST /v1/shipping/labels/cancel/:order_id
//   - Return rates:        POST /v1/shipping/returns/:order_id/fetch_rates
//                          (the ONLY documented returns endpoint). Returns a
//                          request_token tied to the return-rate request plus
//                          return-leg couriers. Return labels are created by
//                          POSTing that request_token to the SAME create-shipment
//                          endpoint (POST /v1/shipping/labels) with the
//                          APPLICATION-selected return courier + service. The
//                          return courier rate carries `total`/`vat` (no
//                          rate_card_amount) and some return couriers have
//                          waybill=false (no waybill document).
//   - Errors:              HTTP status + envelope. 400/404/422/429 -> request
//                          rejected; 401/403 -> bad credentials; 500/503 ->
//                          provider failure.
//
// Money: Shipbubble expresses every amount in the wallet currency's MAJOR units
// (naira) as a JSON number with up to two decimals (e.g. 12451.04, 3063). The
// application represents money as integer MINOR units (kobo). This adapter
// converts ONLY at the boundary using exact decimal-string arithmetic — it never
// uses parseFloat(x) * 100, never rounds an ambiguous value, and never invents a
// price. A quote's amountMinor is taken verbatim from the provider's
// `rate_card_amount` (the amount Shipbubble documents as the price to display to
// the customer), falling back to `total` only when `rate_card_amount` is absent.
//
// Error policy (matches the established Paystack convention): failures surface
// as ShipbubbleLogisticsError, a RepositoryError subclass, so the use-case layer
// maps them onto stable DomainError codes (CONNECTION ->
// EXTERNAL_SERVICE_UNAVAILABLE, TIMEOUT -> EXTERNAL_SERVICE_TIMEOUT, UNKNOWN ->
// EXTERNAL_SERVICE_ERROR). This adapter NEVER throws DomainError, NEVER converts
// an external failure into a successful empty result, and NEVER fabricates a
// label/tracking number.
//
// Idempotency & ambiguity semantics (shipment creation / cancellation):
//   - The adapter NEVER retries a POST automatically. Every request is sent at
//     most once.
//   - A CONNECTION/TIMEOUT failure means the OUTCOME IS UNKNOWN — the request
//     may or may not have been processed provider-side. The adapter marks such
//     failures `meta.ambiguous = true` so the caller records the order as
//     requiring reconciliation instead of re-POSTing.
//   - A shipment created at the provider (order_id known) whose tracking/label
//     enrichment cannot be completed is thrown as a classified error carrying
//     `meta.providerShipmentId` (+ `ambiguous: true`): the shipment EXISTS, so a
//     re-POST would duplicate it.
//   - Cancellation NEVER treats a timeout as proof of cancellation. A TIMEOUT
//     propagates as TIMEOUT (outcome unknown); only an HTTP 200 + success
//     envelope is a confirmed cancellation.
//
// Security:
//   - The API key is required at construction (fail-closed; no default).
//   - The API key, the Authorization header, full request bodies, full provider
//     responses, and customer addresses are NEVER logged or placed in error
//     messages.
//   - Requests are HTTPS (the base URL is enforced to be https), carry the key
//     via "Authorization: Bearer <key>", and use a bounded timeout via
//     AbortController so a network hang can never block a request indefinitely.
//   - The HTTP transport is injectable for tests; it defaults to the global
//     fetch. No HTTP client library is introduced.
//
// Return-label flow (implemented, Phase 8/9 of the reconciliation):
//   1. POST /v1/shipping/returns/:original_order_id/fetch_rates  { pickup_date }
//      -> data.request_token (return rates; token tied to the return request).
//   2. POST /v1/shipping/labels { request_token, service_code, courier_id } with
//      the APPLICATION-selected return courier/service -> the return label's
//      provider order id ("SB-...").
//   3. GET /v1/shipping/labels/list/:id to resolve the return label document
//      (waybill_document) — tolerating return couriers with waybill=false.
//   Cancellation of a return label reuses POST /v1/shipping/labels/cancel/:id,
//   addressed by the RETURN shipment's provider id (never the app orderId).

import type { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { RepositoryError } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import type { StructuredMeta } from "@api/domain/shared/contracts";
import type {
  ProviderShipmentReference,
  ReturnLabelRequest,
  ReturnLabelResult,
  ShippingLabelRequest,
  ShippingLabelResult,
  ShippingQuote,
} from "@api/domain/shared/contracts";
import type { Cart } from "@api/domain/entities/Cart";
import { createHash } from "node:crypto";

/** Injectable HTTP transport; defaults to the native Node fetch API. */
export type ShipbubbleHttpClient = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** Discriminating category for a Shipbubble failure, preserved for observability. */
export type ShipbubbleFailureCategory =
  | "CONFIGURATION"
  | "NETWORK"
  | "TIMEOUT"
  | "GATEWAY_AUTH"
  | "GATEWAY_REJECTED"
  | "GATEWAY_ERROR"
  | "MALFORMED_RESPONSE"
  | "INVALID_PAYLOAD";

/**
 * RepositoryError subclass for Shipbubble failures. The `code` drives the
 * use-case mapping (CONNECTION/TIMEOUT/UNKNOWN); `category` and `cause` keep the
 * exact failure mode available to the adapter/logging without leaking raw
 * fetch/Response objects or provider bodies into application code.
 */
export class ShipbubbleLogisticsError extends Error implements RepositoryError {
  readonly code: RepositoryErrorCode;
  readonly category: ShipbubbleFailureCategory;
  readonly meta?: StructuredMeta;
  readonly cause?: unknown;

  constructor(
    code: RepositoryErrorCode,
    category: ShipbubbleFailureCategory,
    message: string,
    options: { meta?: StructuredMeta; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ShipbubbleLogisticsError";
    this.code = code;
    this.category = category;
    this.meta = options.meta;
    this.cause = options.cause;
  }
}

/**
 * Verified sender/origin address. Shipbubble's rates API identifies endpoints
 * by validated address codes; the origin is a provider-side configuration value
 * owned by this adapter (the application contract carries no origin address).
 */
export interface ShipbubbleSenderAddress {
  name: string;
  email: string;
  phone: string;
  address: string;
}

export interface ShipbubblePackageDimensions {
  length: number;
  width: number;
  height: number;
}

export interface ShipbubbleLogisticsServiceOptions {
  /** Shipbubble API key. REQUIRED — fail-closed; no default, never logged. */
  apiKey: string;
  /** Shipbubble API base URL. Default: https://api.shipbubble.com */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
  /** Pino logger; the adapter logs only non-sensitive operational facts. */
  logger: ILogger;
  /**
   * Verified sender/origin address. REQUIRED — the rates API demands a
   * sender_address_code and the application contract carries no origin.
   */
  senderAddress: ShipbubbleSenderAddress;
  /**
   * Shipbubble package item category id. REQUIRED — every rates request must
   * carry a category_id (see the Shipbubble package-categories API).
   */
  packageCategoryId: number;
  /**
   * Per-item fallback weight in kilograms used when a cart line item's metadata
   * carries no `weightKg`. Default: 1.
   */
  defaultItemWeightKg?: number;
  /**
   * Package dimension fallback (centimetres) used because the application
   * contract carries no parcel dimensions. Default: { length: 10, width: 10,
   * height: 10 }.
   */
  defaultPackageDimensions?: ShipbubblePackageDimensions;
  /** Injectable HTTP transport for tests. Defaults to the global fetch. */
  httpClient?: ShipbubbleHttpClient;
}

const DEFAULT_SHIPBUBBLE_BASE_URL = "https://api.shipbubble.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ITEM_WEIGHT_KG = 1;
const DEFAULT_PACKAGE_DIMENSIONS: ShipbubblePackageDimensions = {
  length: 10,
  width: 10,
  height: 10,
};

/** The wallet currency's minor-unit scale (naira/kobo => 2 decimals). */
const MINOR_UNIT_SCALE = 2;
/** Powers of ten used for exact minor-unit conversion. */
const MINOR_UNIT_MULTIPLIER = 10 ** MINOR_UNIT_SCALE;

// --- Endpoint paths (verified against docs.shipbubble.com) -------------------
const VALIDATE_ADDRESS_PATH = "/v1/shipping/address/validate";
const FETCH_RATES_PATH = "/v1/shipping/fetch_rates";
const CREATE_LABEL_PATH = "/v1/shipping/labels";
const SHIPMENT_LIST_PATH = "/v1/shipping/labels/list";
const CANCEL_LABEL_PATH = "/v1/shipping/labels/cancel";
const RETURN_RATES_PATH = "/v1/shipping/returns";

interface ShipbubbleEnvelope {
  status: "success" | "failed";
  message: string;
  data: Record<string, unknown> | null;
}

interface ShipbubbleCourierRate {
  courierId: string;
  serviceCode: string;
  amountMinor: number;
  currency: string | null;
  etaDays: number | undefined;
}

interface ValidatedRatesData {
  requestToken: string;
  couriers: ShipbubbleCourierRate[];
}

/** Enriched shipment record from GET /v1/shipping/labels/list/:order_ids. */
interface ShipmentRecord {
  trackingNumber: string;
  /** Waybill/label document URL; null when the courier does not require one. */
  labelUrl: string | null;
  courierName: string | null;
}

export class ShipbubbleLogisticsService implements ILogisticsService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: ILogger;
  private readonly httpClient: ShipbubbleHttpClient;
  private readonly senderAddress: ShipbubbleSenderAddress;
  private readonly packageCategoryId: number;
  private readonly defaultItemWeightKg: number;
  private readonly defaultPackageDimensions: ShipbubblePackageDimensions;

  /**
   * In-memory cache of Shipbubble address codes (ints; not secret). Shipbubble
   * returns the same address_code for the same validated address, so caching
   * avoids re-validating an address on every rates call. Bounded: the cache is
   * cleared once it grows past {@link ADDRESS_CACHE_MAX_ENTRIES}.
   */
  private readonly addressCodeCache = new Map<string, number>();
  private static readonly ADDRESS_CACHE_MAX_ENTRIES = 512;

  constructor(options: ShipbubbleLogisticsServiceOptions) {
    if (
      typeof options.apiKey !== "string" ||
      options.apiKey.trim().length === 0
    ) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "CONFIGURATION",
        "ShipbubbleLogisticsService requires a non-empty API key.",
      );
    }
    if (!options.logger) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "CONFIGURATION",
        "ShipbubbleLogisticsService requires a logger.",
      );
    }
    const senderAddress = requireSenderAddress(options.senderAddress);
    if (!Number.isInteger(options.packageCategoryId) || options.packageCategoryId <= 0) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "CONFIGURATION",
        "ShipbubbleLogisticsService requires a positive integer packageCategoryId.",
      );
    }

    this.apiKey = options.apiKey.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_SHIPBUBBLE_BASE_URL);
    this.timeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.logger = options.logger;
    this.httpClient = options.httpClient ?? ((url, init) => fetch(url, init));
    this.senderAddress = senderAddress;
    this.packageCategoryId = options.packageCategoryId;
    this.defaultItemWeightKg =
      options.defaultItemWeightKg ?? DEFAULT_ITEM_WEIGHT_KG;
    this.defaultPackageDimensions = normalizeDimensions(
      options.defaultPackageDimensions ?? DEFAULT_PACKAGE_DIMENSIONS,
    );
  }

  // ---------------------------------------------------------------------------
  // ILogisticsService
  // ---------------------------------------------------------------------------

  /**
   * Fetch live shipping rates for a cart. The cart's destination address is
   * validated with Shipbubble (producing a receiver address code) and the
   * configured sender address produces the sender address code; the cart line
   * items become `package_items` and the configured dimensions become
   * `package_dimension`. Each returned courier is mapped onto a ShippingQuote
   * whose `amountMinor` is the provider's `rate_card_amount` converted verbatim
   * into minor units.
   *
   * The adapter makes NO business decision here — it returns every courier
   * Shipbubble returned, mapped faithfully. It never modifies the cart, never
   * persists anything, and never writes to a database.
   */
  async fetchDynamicRates(cart: Cart): Promise<ShippingQuote[]> {
    if (typeof cart !== "object" || cart === null) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "fetchDynamicRates requires a Cart.",
      );
    }

    if (typeof cart.shippingAddress !== "object" || cart.shippingAddress === null) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "The cart has no shipping address; Shipbubble rates require a validated destination address.",
      );
    }
    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "The cart has no items; Shipbubble rates require at least one package item.",
      );
    }

    // --- Map the application payload onto Shipbubble's exact request shape ----
    const receiver = this.buildReceiverAddress(cart);
    const packageItems = cart.items.map((item) =>
      this.toPackageItem(item),
    );

    const senderAddressCode = await this.resolveAddressCode(this.senderAddress);
    const receiverAddressCode = await this.resolveAddressCode(receiver);

    const body = {
      sender_address_code: senderAddressCode,
      reciever_address_code: receiverAddressCode,
      pickup_date: formatPickupDate(new Date()),
      category_id: this.packageCategoryId,
      package_items: packageItems,
      package_dimension: this.defaultPackageDimensions,
    };

    const envelope = await this.post(FETCH_RATES_PATH, body, "shipping.fetch_rates");

    const validated = this.validateRatesData(envelope.data);
    this.logger.info("Shipbubble shipping rates fetched", {
      operation: "shipping.fetch_rates",
      quoteCount: validated.couriers.length,
    });
    return validated.couriers.map((courier) => ({
      id: buildQuoteId(validated.requestToken, courier.courierId, courier.serviceCode),
      serviceLevel: courier.serviceCode,
      amountMinor: courier.amountMinor,
      currency: courier.currency ?? undefined,
      etaDays: courier.etaDays,
      courierId: courier.courierId,
      serviceCode: courier.serviceCode,
      requestToken: validated.requestToken,
    }));
  }

  /**
   * Create a shipment from the application's frozen shipping selection.
   *
   * Two-step provider flow:
   *   1. POST /v1/shipping/labels with { request_token, service_code,
   *      courier_id } — the request_token and the courier/service came from the
   *      persisted rate response, so the adapter is never asked to choose a
   *      courier. The response yields the PROVIDER order id ("SB-...").
   *   2. GET /v1/shipping/labels/list/:order_id to resolve the courier's
   *      tracking code and the waybill/label document URL, which the create
   *      response does not carry.
   *
   * The adapter NEVER retries a POST. Failures keep their exact classification:
   *   - POST failed (CONNECTION/TIMEOUT/...): outcome UNKNOWN — thrown with
   *     `meta.ambiguous = true` so the caller records the order as requiring
   *     reconciliation instead of re-POSTing.
   *   - POST succeeded but enrichment failed: thrown with the SAME
   *     classification PLUS `meta.providerShipmentId` — the shipment EXISTS at
   *     the provider, so a re-POST would duplicate it.
   * The raw provider response is never exposed; only a validated
   * ShippingLabelResult (or a classified ShipbubbleLogisticsError) escapes.
   */
  async createShippingLabel(
    request: ShippingLabelRequest,
  ): Promise<ShippingLabelResult> {
    this.validateShippingLabelRequest(request);
    const selection = request.selection;

    const body = {
      request_token: request.requestToken,
      service_code: selection.serviceCode,
      courier_id: selection.courierId,
    };

    // --- Step 1: create the shipment at the provider -------------------------
    let envelope: ShipbubbleEnvelope;
    try {
      envelope = await this.post(CREATE_LABEL_PATH, body, "shipping.labels.create");
    } catch (err: unknown) {
      // Classify by outcome knowledge. A DEFINITE provider rejection
      // (GATEWAY_REJECTED / GATEWAY_AUTH) means the request was validated and
      // rejected — NO shipment exists — so the caller records a terminal
      // failure (DispatchState `failed`) rather than a reconciliation
      // requirement. Everything else (timeout / network / gateway 5xx /
      // malformed) leaves the outcome UNKNOWN — the request may or may not
      // have been processed — and is re-thrown as AMBIGUOUS so the caller
      // persists `requires_reconciliation` and never issues another POST.
      if (isDefiniteRejection(err)) {
        throw err;
      }
      throw reclassifyWithMeta(err, { ambiguous: true });
    }

    const providerShipmentId = readProviderId(envelope.data?.["order_id"]);
    if (!providerShipmentId) {
      // The create responded but carries no provider id: the shipment may still
      // exist provider-side. Ambiguous — never retry.
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble shipment creation did not return an order_id.",
        { meta: { ambiguous: true } },
      );
    }

    // --- Step 2: resolve tracking code + waybill document --------------------
    let shipmentRecord: ShipmentRecord;
    try {
      shipmentRecord = await this.fetchShipmentRecord(providerShipmentId);
    } catch (err: unknown) {
      // The shipment EXISTS (provider id known) but its tracking/label details
      // could not be resolved. Keep the failure classification and attach the
      // provider id so the caller knows a re-POST would duplicate the shipment.
      throw reclassifyWithMeta(err, {
        ambiguous: true,
        providerShipmentId,
      });
    }

    this.logger.info("Shipbubble shipment created", {
      operation: "shipping.labels.create",
      providerShipmentId,
      trackingResolved: true,
    });

    return {
      providerShipmentId,
      trackingNumber: shipmentRecord.trackingNumber,
      labelUrl: shipmentRecord.labelUrl,
      courier: shipmentRecord.courierName,
      serviceLevel: selection.serviceLevel ?? null,
    };
  }

  /**
   * Cancel an existing shipment by its PROVIDER order id
   * (POST /v1/shipping/labels/cancel/:order_id). Never the application orderId.
   *
   * The request is sent at most once; a timeout/network failure propagates as
   * TIMEOUT/CONNECTION and is NEVER treated as proof of cancellation — only a
   * 200 + success envelope confirms the cancellation. A provider rejection
   * (e.g. "Shipment label already processed") surfaces as GATEWAY_REJECTED.
   * The adapter never touches PostgreSQL.
   */
  async cancelFulfillment(
    _orderId: string,
    reference: ProviderShipmentReference,
  ): Promise<void> {
    const providerShipmentId = reference?.providerShipmentId?.trim();
    if (!providerShipmentId) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "cancelFulfillment requires the provider shipment id (never the application orderId).",
      );
    }

    const path = `${CANCEL_LABEL_PATH}/${encodeURIComponent(providerShipmentId)}`;
    await this.post(path, {}, "shipping.labels.cancel");

    this.logger.info("Shipbubble shipment cancelled", {
      operation: "shipping.labels.cancel",
      providerShipmentId,
    });
  }

  /**
   * Create a return (reverse) shipping label originating from the ORIGINAL
   * outbound shipment's provider id.
   *
   * Three-step provider flow:
   *   1. POST /v1/shipping/returns/:original_order_id/fetch_rates
   *      { pickup_date } -> the return-rates request_token (the ONLY documented
   *      returns endpoint; return labels start from the original shipment's
   *      provider order id, never the application orderId).
   *   2. POST /v1/shipping/labels with { request_token, service_code,
   *      courier_id } — the token comes from step 1 and the courier/service
   *      come from the APPLICATION-supplied returnSelection, so the adapter is
   *      never asked to choose a return courier. The response yields the return
   *      shipment's PROVIDER order id ("SB-...").
   *   3. GET /v1/shipping/labels/list/:id to resolve the return label document
   *      URL (waybill_document). Some return couriers have waybill=false (no
   *      document) and tracking may not exist until pickup, so those are
   *      tolerated; a missing record is treated as ambiguous.
   *
   * The adapter NEVER retries a POST. Failures keep their exact classification:
   *   - POST failed (CONNECTION/TIMEOUT/...): outcome UNKNOWN — thrown with
   *     `meta.ambiguous = true` so the caller does not re-POST.
   *   - The return label was created (provider id known) but its record could
   *     not be resolved: thrown with the SAME classification PLUS
   *     `meta.providerShipmentId` — the label EXISTS, so a re-POST would
   *     duplicate it.
   */
  async createReturnLabel(
    request: ReturnLabelRequest,
  ): Promise<ReturnLabelResult> {
    this.validateReturnLabelRequest(request);
    const originalProviderShipmentId =
      request.originalShipment.providerShipmentId.trim();
    const returnSelection = request.returnSelection;

    // --- Step 1: fetch return rates for the ORIGINAL outbound shipment -------
    let ratesEnvelope: ShipbubbleEnvelope;
    try {
      ratesEnvelope = await this.post(
        `${RETURN_RATES_PATH}/${encodeURIComponent(
          originalProviderShipmentId,
        )}/fetch_rates`,
        { pickup_date: formatPickupDate(new Date()) },
        "shipping.returns.fetch_rates",
      );
    } catch (err: unknown) {
      // The rates request may or may not have been processed. Ambiguous — never
      // retry.
      throw reclassifyWithMeta(err, { ambiguous: true });
    }

    const requestToken = requireNonEmptyString(
      ratesEnvelope.data ?? {},
      "request_token",
    );
    if (!requestToken) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble return-rates response did not include a request_token.",
      );
    }

    // --- Step 2: create the return label from the token + application choice --
    let createEnvelope: ShipbubbleEnvelope;
    try {
      createEnvelope = await this.post(
        CREATE_LABEL_PATH,
        {
          request_token: requestToken,
          service_code: returnSelection.serviceCode,
          courier_id: returnSelection.courierId,
        },
        "shipping.return_labels.create",
      );
    } catch (err: unknown) {
      // The request may or may not have been processed. Ambiguous — never retry.
      throw reclassifyWithMeta(err, { ambiguous: true });
    }

    const providerShipmentId = readProviderId(createEnvelope.data?.["order_id"]);
    if (!providerShipmentId) {
      // The create responded but carries no provider id: the return label may
      // still exist provider-side. Ambiguous — never retry.
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble return label creation did not return an order_id.",
        { meta: { ambiguous: true } },
      );
    }

    // --- Step 3: resolve the return label document ---------------------------
    let record: ShipmentRecord;
    try {
      record = await this.fetchReturnShipmentRecord(providerShipmentId);
    } catch (err: unknown) {
      // The return label EXISTS (provider id known) but its record could not be
      // resolved. Keep the classification and attach the provider id so the
      // caller knows a re-POST would duplicate the label.
      throw reclassifyWithMeta(err, {
        ambiguous: true,
        providerShipmentId,
      });
    }

    this.logger.info("Shipbubble return label created", {
      operation: "shipping.return_labels.create",
      providerShipmentId,
    });

    return {
      providerShipmentId,
      url: record.labelUrl,
    };
  }

  /**
   * Cancel a previously created return label by its PROVIDER shipment id
   * (POST /v1/shipping/labels/cancel/:order_id — a return label is itself a
   * shipment). Never the application orderId.
   *
   * The request is sent at most once; a timeout/network failure propagates as
   * TIMEOUT/CONNECTION and is NEVER treated as proof of cancellation — only a
   * 200 + success envelope confirms the cancellation. A provider rejection
   * (e.g. "Shipment label already processed") surfaces as GATEWAY_REJECTED.
   * The adapter never touches PostgreSQL.
   */
  async cancelReturnLabel(
    _orderId: string,
    reference: ProviderShipmentReference,
  ): Promise<void> {
    const providerShipmentId = reference?.providerShipmentId?.trim();
    if (!providerShipmentId) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "cancelReturnLabel requires the return shipment's provider id (never the application orderId).",
      );
    }

    const path = `${CANCEL_LABEL_PATH}/${encodeURIComponent(providerShipmentId)}`;
    await this.post(path, {}, "shipping.return_labels.cancel");

    this.logger.info("Shipbubble return label cancelled", {
      operation: "shipping.return_labels.cancel",
      providerShipmentId,
    });
  }

  // ---------------------------------------------------------------------------
  // Address validation
  // ---------------------------------------------------------------------------

  /**
   * Ensure a Shipbubble address exists and return its `address_code`. Cached by
   * a normalized address key so repeated rates requests reuse the same code;
   * cache is bounded and never logged.
   */
  private async resolveAddressCode(address: ShipbubbleSenderAddress): Promise<number> {
    const key = addressCacheKey(address);
    const cached = this.addressCodeCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const body: Record<string, string> = {
      name: address.name,
      email: address.email,
      phone: address.phone,
      address: address.address,
    };
    const envelope = await this.post(VALIDATE_ADDRESS_PATH, body, "shipping.address.validate");
    const code = readIntField(envelope.data, "address_code");
    if (code === null) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble address validation did not return an address_code.",
      );
    }

    if (this.addressCodeCache.size >= ShipbubbleLogisticsService.ADDRESS_CACHE_MAX_ENTRIES) {
      this.addressCodeCache.clear();
    }
    this.addressCodeCache.set(key, code);
    return code;
  }

  /** Map the cart's destination onto Shipbubble's required address fields. */
  private buildReceiverAddress(cart: Cart): ShipbubbleSenderAddress {
    const address = cart.shippingAddress as Record<string, unknown> | null;
    const firstName = optionalString(address?.firstName);
    const lastName = optionalString(address?.lastName);
    const company = optionalString(address?.company);
    const name = [firstName, lastName].filter(Boolean).join(" ").trim() || company || null;
    const email = optionalString(cart.email);
    const phone = optionalString(address?.phone);
    const street = composeAddressString(address);

    if (!name || !email || !phone || !street) {
      const missing = [
        name ? null : "name",
        email ? null : "email",
        phone ? null : "phone",
        street ? null : "address",
      ].filter(Boolean);
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        `The cart shipping address lacks the fields Shipbubble requires for address validation: ${missing.join(", ")}.`,
      );
    }

    return { name, email, phone, address: street };
  }

  // ---------------------------------------------------------------------------
  // Rates mapping
  // ---------------------------------------------------------------------------

  /** Map a cart line item onto Shipbubble's `package_items` entry. */
  private toPackageItem(item: {
    id: string;
    title?: string;
    quantity: number;
    unitPriceMinor: number;
    metadata?: Record<string, unknown>;
  }): Record<string, string | number> {
    const title = optionalString(item.title) ?? item.id;
    const description =
      optionalString((item.metadata ?? {})["description"] as unknown) ?? title;
    const weightKg = readWeightFromMetadata(item.metadata, this.defaultItemWeightKg);
    const amountMajor = minorToMajorString(item.unitPriceMinor);

    return {
      name: title,
      description,
      unit_weight: formatWeight(weightKg),
      unit_amount: amountMajor,
      quantity: item.quantity,
    };
  }

  /** Structural validation of the fetch_rates data; no blind casting. */
  private validateRatesData(data: Record<string, unknown> | null): ValidatedRatesData {
    if (typeof data !== "object" || data === null) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble rates response did not include a data object.",
      );
    }

    const requestToken = requireNonEmptyString(data, "request_token");
    if (requestToken === null) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble rates response did not include a request_token.",
      );
    }

    if (!Array.isArray(data.couriers)) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble rates response did not include a couriers array.",
      );
    }

    const couriers = data.couriers.map((courier) => this.toCourierRate(courier));
    return { requestToken, couriers };
  }

  /** Map one Shipbubble courier rate onto the application's ShippingQuote. */
  private toCourierRate(value: unknown): ShipbubbleCourierRate {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble returned a malformed courier rate entry.",
      );
    }
    const courier = value as Record<string, unknown>;

    const courierId = readProviderId(courier.courier_id);
    if (!courierId) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble courier rate is missing courier_id.",
      );
    }
    const serviceCode = optionalString(courier.service_code);
    if (!serviceCode) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble courier rate is missing service_code.",
      );
    }

    // rate_card_amount is the amount Shipbubble documents as the customer-facing
    // shipping cost; total is the wallet charge. Prefer rate_card_amount and only
    // fall back to total when it is absent — never silently invent a price.
    const rateCardAmount = courier.rate_card_amount;
    const fallbackTotal = courier.total;
    let amountMinor: number;
    if (rateCardAmount !== undefined && rateCardAmount !== null) {
      amountMinor = majorNumberToMinor(rateCardAmount, "rate_card_amount");
    } else if (fallbackTotal !== undefined && fallbackTotal !== null) {
      amountMinor = majorNumberToMinor(fallbackTotal, "total");
    } else {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble courier rate carries neither rate_card_amount nor total.",
      );
    }

    return {
      courierId,
      serviceCode,
      amountMinor,
      currency: optionalString(courier.currency),
      etaDays: computeEtaDays(courier.delivery_eta_time),
    };
  }

  // ---------------------------------------------------------------------------
  // Request pipeline
  // ---------------------------------------------------------------------------

  /**
   * POST a JSON body to a Shipbubble path with a bounded timeout, validating the
   * HTTP status and the Shipbubble envelope. Every failure is normalized to a
   * ShipbubbleLogisticsError; raw fetch/Response/TypeError/JSON errors never
   * escape this method.
   */
  private async post(
    path: string,
    body: Record<string, unknown>,
    operation: string,
  ): Promise<ShipbubbleEnvelope> {
    return this.send("POST", path, body, operation);
  }

  /** GET a Shipbubble path with the same bounded-timeout/validation pipeline. */
  private async get(
    path: string,
    operation: string,
  ): Promise<ShipbubbleEnvelope> {
    return this.send("GET", path, undefined, operation);
  }

  /** Shared bounded-timeout HTTP pipeline for POST/GET requests. */
  private async send(
    method: "POST" | "GET",
    path: string,
    body: Record<string, unknown> | undefined,
    operation: string,
  ): Promise<ShipbubbleEnvelope> {
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      response = await this.httpClient(url, init);
    } catch (err: unknown) {
      if (isAbortError(err)) {
        this.logger.error("Shipbubble request timed out", {
          operation,
          timeoutMs: this.timeoutMs,
        });
        throw new ShipbubbleLogisticsError(
          RepositoryErrorCode.TIMEOUT,
          "TIMEOUT",
          `Shipbubble request timed out after ${this.timeoutMs}ms.`,
          { cause: err },
        );
      }
      this.logger.error("Failed to reach Shipbubble", {
        operation,
        err,
      });
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.CONNECTION,
        "NETWORK",
        "Failed to reach Shipbubble.",
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const status = response.status;
      this.logger.error("Shipbubble request returned a non-2xx status", {
        operation,
        httpStatus: status,
        latencyMs,
      });
      if (status === 401 || status === 403) {
        throw new ShipbubbleLogisticsError(
          RepositoryErrorCode.UNKNOWN,
          "GATEWAY_AUTH",
          "Shipbubble rejected the API credentials.",
          { meta: { httpStatus: status } },
        );
      }
      if (status >= 500) {
        throw new ShipbubbleLogisticsError(
          RepositoryErrorCode.UNKNOWN,
          "GATEWAY_ERROR",
          `Shipbubble gateway error (HTTP ${status}).`,
          { meta: { httpStatus: status } },
        );
      }
      const gatewayMessage = await this.readSafeMessage(response);
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "GATEWAY_REJECTED",
        gatewayMessage ?? `Shipbubble rejected the request (HTTP ${status}).`,
        { meta: { httpStatus: status } },
      );
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (err: unknown) {
      this.logger.error("Shipbubble returned a malformed (non-JSON) response", {
        operation,
        err,
      });
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble returned a non-JSON response.",
      );
    }

    this.logger.info("Shipbubble request succeeded", {
      operation,
      httpStatus: response.status,
      latencyMs,
    });
    return this.validateEnvelope(envelope, operation);
  }

  // ---------------------------------------------------------------------------
  // Shipment enrichment (create -> tracking/label resolution)
  // ---------------------------------------------------------------------------

  /** Structural validation of the application's shipping label request. */
  private validateShippingLabelRequest(request: ShippingLabelRequest): void {
    if (typeof request !== "object" || request === null) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "createShippingLabel requires a ShippingLabelRequest.",
      );
    }
    const token = optionalString(request.requestToken);
    const selection = request.selection;
    const courierId = optionalString(selection?.courierId);
    const serviceCode = optionalString(selection?.serviceCode);
    const destination =
      typeof request.destination === "object" && request.destination !== null
        ? request.destination
        : null;
    const hasParcelItems = Array.isArray(request.parcelItems) &&
      request.parcelItems.length > 0;

    if (!token || !courierId || !serviceCode) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "createShippingLabel requires the rate response request_token and the selected courier_id + service_code.",
      );
    }
    if (!destination) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "createShippingLabel requires a destination address.",
      );
    }
    if (!hasParcelItems) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "createShippingLabel requires at least one parcel item.",
      );
    }
  }

  /** Structural validation of the application's return label request. */
  private validateReturnLabelRequest(request: ReturnLabelRequest): void {
    if (typeof request !== "object" || request === null) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "createReturnLabel requires a ReturnLabelRequest.",
      );
    }
    const originalProviderShipmentId = optionalString(
      request.originalShipment?.providerShipmentId,
    );
    const returnSelection = request.returnSelection;
    const courierId = optionalString(returnSelection?.courierId);
    const serviceCode = optionalString(returnSelection?.serviceCode);
    const destination =
      typeof request.destination === "object" && request.destination !== null
        ? request.destination
        : null;
    const hasParcelItems =
      Array.isArray(request.parcelItems) && request.parcelItems.length > 0;

    if (!originalProviderShipmentId) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "createReturnLabel requires the original outbound shipment's provider id (never the application orderId).",
      );
    }
    if (!courierId || !serviceCode) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "createReturnLabel requires the APPLICATION-selected return courier_id + service_code.",
      );
    }
    if (!destination) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "createReturnLabel requires the pickup (customer) destination address.",
      );
    }
    if (!hasParcelItems) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "INVALID_PAYLOAD",
        "createReturnLabel requires at least one parcel item being returned.",
      );
    }
  }

  /**
   * Fetch the enriched shipment record for a provider order id via
   * GET /v1/shipping/labels/list/:order_id and extract the courier tracking
   * code and the waybill/label document URL. Throws MALFORMED_RESPONSE when the
   * record cannot be resolved or carries no tracking code.
   */
  private async fetchShipmentRecord(
    providerShipmentId: string,
  ): Promise<ShipmentRecord> {
    return this.resolveShipmentRecord(providerShipmentId, true);
  }

  /**
   * Lenient variant of {@link fetchShipmentRecord} for return labels: a missing
   * tracking code is tolerated (return couriers often expose tracking only
   * after pickup) and a missing waybill document is normal for waybill=false
   * couriers. Throws only when the record itself cannot be resolved.
   */
  private async fetchReturnShipmentRecord(
    providerShipmentId: string,
  ): Promise<ShipmentRecord> {
    return this.resolveShipmentRecord(providerShipmentId, false);
  }

  /** Shared shipment-record resolution for outbound and return labels. */
  private async resolveShipmentRecord(
    providerShipmentId: string,
    requireTrackingCode: boolean,
  ): Promise<ShipmentRecord> {
    const envelope = await this.get(
      `${SHIPMENT_LIST_PATH}/${encodeURIComponent(providerShipmentId)}`,
      requireTrackingCode ? "shipping.labels.get" : "shipping.return_labels.get",
    );

    const data = envelope.data;
    if (!data || !Array.isArray(data.results)) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble shipment list response did not include a results array.",
      );
    }

    const record = (data.results as unknown[]).find((candidate) => {
      if (typeof candidate !== "object" || candidate === null) {
        return false;
      }
      const entry = candidate as Record<string, unknown>;
      return (
        typeof entry.order_id === "string" &&
        entry.order_id === providerShipmentId
      );
    });

    if (!record) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble shipment record could not be resolved after creation.",
      );
    }

    const entry = record as Record<string, unknown>;
    const courier =
      typeof entry.courier === "object" && entry.courier !== null
        ? (entry.courier as Record<string, unknown>)
        : null;

    const trackingNumber = optionalString(courier?.tracking_code);
    if (requireTrackingCode && !trackingNumber) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble shipment record carries no courier tracking code.",
      );
    }

    return {
      trackingNumber: trackingNumber ?? "",
      labelUrl: optionalString(entry.waybill_document) ?? null,
      courierName: optionalString(courier?.name),
    };
  }

  /** Structural validation of the Shipbubble envelope; no blind casting. */
  private validateEnvelope(value: unknown, operation: string): ShipbubbleEnvelope {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble response was not a JSON object.",
      );
    }
    const env = value as Record<string, unknown>;

    const status = optionalString(env.status);
    if (status !== "success" && status !== "failed") {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        "Shipbubble response is missing a success/failed status field.",
      );
    }

    if (status === "failed") {
      const message =
        typeof env.message === "string" && env.message.trim().length > 0
          ? env.message.trim()
          : "Shipbubble rejected the request.";
      this.logger.warn("Shipbubble rejected the request", {
        operation,
        gatewayMessage: message,
      });
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "GATEWAY_REJECTED",
        message,
      );
    }

    const data =
      typeof env.data === "object" && env.data !== null && !Array.isArray(env.data)
        ? (env.data as Record<string, unknown>)
        : null;

    return {
      status: "success",
      message: typeof env.message === "string" ? env.message : "",
      data,
    };
  }

  /** Read a human-safe gateway message without logging the full body. */
  private async readSafeMessage(response: Response): Promise<string | null> {
    try {
      const parsed: unknown = await response.json();
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).message === "string"
      ) {
        const message = ((parsed as Record<string, unknown>).message as string).trim();
        return message.length > 0 ? message : null;
      }
    } catch {
      return null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small validation helpers (kept module-local; no Shipbubble types leak out)
// ---------------------------------------------------------------------------

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(trimmed)) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "CONFIGURATION",
      "Shipbubble base URL must use HTTPS.",
    );
  }
  return trimmed;
}

function normalizeTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "CONFIGURATION",
      "Shipbubble timeout must be a positive integer of milliseconds.",
    );
  }
  return value;
}

function requireSenderAddress(value: unknown): ShipbubbleSenderAddress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "CONFIGURATION",
      "ShipbubbleLogisticsService requires a senderAddress.",
    );
  }
  const o = value as Record<string, unknown>;
  const name = optionalString(o.name);
  const email = optionalString(o.email);
  const phone = optionalString(o.phone);
  const address = optionalString(o.address);
  if (!name || !email || !phone || !address) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "CONFIGURATION",
      "ShipbubbleLogisticsService requires a senderAddress with name, email, phone and address.",
    );
  }
  return { name, email, phone, address };
}

function normalizeDimensions(
  value: ShipbubblePackageDimensions,
): ShipbubblePackageDimensions {
  const { length, width, height } = value;
  if (
    !isPositiveFinite(length) ||
    !isPositiveFinite(width) ||
    !isPositiveFinite(height)
  ) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "CONFIGURATION",
      "Shipbubble package dimensions must be positive finite numbers in centimetres.",
    );
  }
  return { length, width, height };
}

function isPositiveFinite(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Require a non-empty string field on a validated provider data object.
 * Returns null (rather than throwing) so callers can tailor the message.
 */
function requireNonEmptyString(data: Record<string, unknown>, field: string): string | null {
  return optionalString(data[field]);
}

/** Read a required integer field (e.g. address_code) from validated data. */
function readIntField(
  data: Record<string, unknown> | null,
  field: string,
): number | null {
  if (!data) {
    return null;
  }
  const value = data[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

/** courier_id arrives as either a string ("cora") or a number (1). */
function readProviderId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Money conversion (exact; never parseFloat(x) * 100)
// ---------------------------------------------------------------------------

/**
 * Convert a provider amount in major units to integer minor units. Integers
 * are converted exactly. Decimals are converted through their ECMAScript
 * round-trip decimal string (String(x) is the shortest decimal that reproduces
 * the exact float), then parsed as an exact decimal. A value that needs more
 * precision than the currency scale is an AMBIGUOUS value and is REJECTED —
 * never silently rounded.
 */
function majorNumberToMinor(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "MALFORMED_RESPONSE",
      `Shipbubble returned an invalid ${field} amount.`,
    );
  }
  if (Number.isInteger(value)) {
    const minor = value * MINOR_UNIT_MULTIPLIER;
    if (!Number.isSafeInteger(minor)) {
      throw new ShipbubbleLogisticsError(
        RepositoryErrorCode.UNKNOWN,
        "MALFORMED_RESPONSE",
        `Shipbubble ${field} amount exceeds safe integer range in minor units.`,
      );
    }
    return minor;
  }
  return decimalStringToMinor(String(value), field);
}

function decimalStringToMinor(decimal: string, field: string): number {
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "MALFORMED_RESPONSE",
      `Shipbubble returned an ambiguous ${field} amount.`,
    );
  }
  const [wholePart, fracPartRaw = ""] = decimal.split(".");
  if (fracPartRaw.length > MINOR_UNIT_SCALE) {
    // More precision than the currency supports -> ambiguous; do NOT round.
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "MALFORMED_RESPONSE",
      `Shipbubble returned a ${field} amount with more than ${MINOR_UNIT_SCALE} decimal places.`,
    );
  }
  const whole = Number(wholePart);
  const frac = Number(fracPartRaw.padEnd(MINOR_UNIT_SCALE, "0"));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(frac)) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "MALFORMED_RESPONSE",
      `Shipbubble returned an out-of-range ${field} amount.`,
    );
  }
  const minor = whole * MINOR_UNIT_MULTIPLIER + frac;
  if (!Number.isSafeInteger(minor)) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "MALFORMED_RESPONSE",
      `Shipbubble ${field} amount exceeds safe integer range in minor units.`,
    );
  }
  return minor;
}

/**
 * Convert an application minor-unit amount to Shipbubble's major-unit decimal
 * string (e.g. 500000 kobo -> "5000"; 125 kobo -> "1.25"). Exact integer math.
 */
function minorToMajorString(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new ShipbubbleLogisticsError(
      RepositoryErrorCode.UNKNOWN,
      "INVALID_PAYLOAD",
      "Cart item unit price must be a non-negative integer in minor units.",
    );
  }
  const whole = Math.trunc(minor / MINOR_UNIT_MULTIPLIER);
  const frac = minor % MINOR_UNIT_MULTIPLIER;
  if (frac === 0) {
    return String(whole);
  }
  return `${whole}.${String(frac).padStart(MINOR_UNIT_SCALE, "0")}`;
}

// ---------------------------------------------------------------------------
// Package / date helpers
// ---------------------------------------------------------------------------

/** Weight in kilograms: metadata.weightKg wins, else the configured default. */
function readWeightFromMetadata(
  metadata: Record<string, unknown> | undefined,
  defaultWeightKg: number,
): number {
  const raw = metadata?.["weightKg"];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return defaultWeightKg;
}

/** Format a weight in kilograms as Shipbubble's decimal string (e.g. "0.5"). */
function formatWeight(weightKg: number): string {
  return String(weightKg);
}

/** Compose Shipbubble's single-line address string from the cart address fields. */
function composeAddressString(address: Record<string, unknown> | null): string | null {
  if (!address) {
    return null;
  }
  const parts = [
    optionalString(address.line1),
    optionalString(address.line2),
    optionalString(address.city),
    optionalString(address.state),
    optionalString(address.postalCode),
    optionalString(address.countryCode),
  ].filter((part): part is string => part !== null);
  const joined = parts.join(", ").trim();
  return joined.length > 0 ? joined : null;
}

/** Today's date in Shipbubble's required "yyyy-mm-dd" pickup_date format. */
function formatPickupDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Estimate delivery ETA in whole days from Shipbubble's `delivery_eta_time`
 * ("yyyy-mm-dd HH:mm:ss"). Returns undefined when unparseable or in the past.
 */
function computeEtaDays(raw: unknown): number | undefined {
  const value = optionalString(raw);
  if (!value) {
    return undefined;
  }
  const parsed = parseShipbubbleDateTime(value);
  if (!parsed) {
    return undefined;
  }
  const diffMs = parsed.getTime() - Date.now();
  const days = Math.ceil(diffMs / 86_400_000);
  return days >= 0 ? days : undefined;
}

function parseShipbubbleDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Normalized cache key for a validated address (never logged). */
function addressCacheKey(address: ShipbubbleSenderAddress): string {
  return [address.name, address.email, address.phone, address.address]
    .join("|")
    .toLowerCase()
    .trim();
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * True when a shipment-creation failure is a DEFINITE provider rejection (the
 * request was validated and rejected; no shipment exists) rather than an
 * ambiguous outcome. The dispatch use case records these as a terminal `failed`
 * state instead of a `requires_reconciliation` marker.
 */
function isDefiniteRejection(err: unknown): boolean {
  return (
    err instanceof ShipbubbleLogisticsError &&
    (err.category === "GATEWAY_REJECTED" || err.category === "GATEWAY_AUTH")
  );
}

/**
 * Re-throw a ShipbubbleLogisticsError with additional structured meta. Used to
 * attach `ambiguous` / `providerShipmentId` signals that the use-case layer
 * reads to decide between reconciliation and plain failure handling. Never
 * leaks raw fetch/Response objects.
 */
function reclassifyWithMeta(
  err: unknown,
  extraMeta: Record<string, unknown>,
): ShipbubbleLogisticsError {
  if (err instanceof ShipbubbleLogisticsError) {
    return new ShipbubbleLogisticsError(err.code, err.category, err.message, {
      cause: err.cause,
      meta: { ...(err.meta ?? {}), ...extraMeta },
    });
  }
  return new ShipbubbleLogisticsError(
    RepositoryErrorCode.UNKNOWN,
    "MALFORMED_RESPONSE",
    "Unexpected Shipbubble failure.",
    { cause: err, meta: extraMeta },
  );
}

/**
 * Deterministic application quote id (uuid-v5-style) derived from the provider
 * request_token + courier + service of a rate entry. The same rate response
 * always yields the same ids, so a client selection is stable for the duration
 * of the persisted request_token.
 */
function buildQuoteId(requestToken: string, courierId: string, serviceCode: string): string {
  const hash = createHash("sha1")
    .update(`${requestToken}|${courierId}|${serviceCode}`, "utf8")
    .digest();
  const hex = hash.toString("hex");
  const timeLow = hex.slice(0, 8);
  const timeMid = hex.slice(8, 12);
  const timeHigh = (Number.parseInt(hex.slice(12, 16), 16) & 0x0fff) | 0x5000;
  const clockSeq = (Number.parseInt(hex.slice(16, 20), 16) & 0x3fff) | 0x8000;
  const node = hex.slice(20, 32);
  return `${timeLow}-${timeMid}-${timeHigh.toString(16).padStart(4, "0")}-${clockSeq
    .toString(16)
    .padStart(4, "0")}-${node}`;
}
