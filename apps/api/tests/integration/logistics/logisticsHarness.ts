// apps/api/tests/integration/logistics/logisticsHarness.ts
//
// Shared composition harness for the L6 logistics INTEGRATION suites. Wires the
// in-memory fakes exactly as the real composition root wires infrastructure,
// and exposes the six use cases that form the authoritative logistics
// lifecycle:
//
//   RetrieveDynamicShippingQuotesUseCase  -> fetch + persist server quotes
//   SelectShippingOptionUseCase           -> server-side quote selection
//   DispatchOrderFulfillmentUseCase       -> frozen-snapshot shipment creation
//   ProcessCourierTrackingEventUseCase    -> worker reconciliation (consumer)
//   QueueLogisticsEventUseCase            -> typed, idempotent enqueue (producer)
//   VerifyLogisticsEventSignatureUseCase  -> HMAC webhook gate
//
// Also exports the dispatch fixtures (frozen shipping snapshot + dispatchable
// order) and shared provider-event helpers. No HTTP, no Postgres, no
// Shipbubble — the provider-neutral boundaries are exercised at the
// application edge.

import { Cart } from "@api/domain/entities/Cart";
import { Order } from "@api/domain/entities/Order";
import type { ITransactionManager } from "@api/domain/interfaces/shared/ITransactionManager";
import {
  OrderShippingSnapshot,
  ProviderLogisticsEvent,
  ShippingQuote,
} from "@api/domain/shared/contracts";
import { LogisticsEventJobPayload } from "@api/domain/shared/jobs";
import { DispatchOrderFulfillmentUseCase } from "@api/use-cases/logistics/DispatchOrderFulfillmentUseCase";
import { ProcessCourierTrackingEventUseCase } from "@api/use-cases/logistics/ProcessCourierTrackingEventUseCase";
import { QueueLogisticsEventUseCase } from "@api/use-cases/logistics/QueueLogisticsEventUseCase";
import { VerifyLogisticsEventSignatureUseCase } from "@api/use-cases/logistics/VerifyLogisticsEventSignatureUseCase";
import { RetrieveDynamicShippingQuotesUseCase } from "@api/use-cases/checkout/RetrieveDynamicShippingQuotesUseCase";
import { SelectShippingOptionUseCase } from "@api/use-cases/checkout/SelectShippingOptionUseCase";
import { InMemoryCartRepository } from "../../fakes/InMemoryCartRepository";
import { InMemoryOrderRepository } from "../../fakes/InMemoryOrderRepository";
import { InMemoryFulfillmentRepository } from "../../fakes/InMemoryFulfillmentRepository";
import { InMemoryNotificationOutboxRepository } from "../../fakes/InMemoryNotificationOutboxRepository";
import { InMemoryPaymentRepository } from "../../fakes/InMemoryPaymentRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { FakeLogisticsService } from "../../fakes/FakeLogisticsService";
import { FakeQueueService } from "../../fakes/FakeQueueService";
import { FakeCryptographyService } from "../../fakes/FakeCryptographyService";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { buildCheckoutCart } from "../../fixtures/cartFactory";

export interface LogisticsHarnessOptions {
  cart?: Cart;
  order?: Order;
  transactionManager?: ITransactionManager;
  cartRepository?: InMemoryCartRepository;
  orderRepository?: InMemoryOrderRepository;
  paymentRepository?: InMemoryPaymentRepository;
  fulfillmentRepository?: InMemoryFulfillmentRepository;
  logisticsService?: FakeLogisticsService;
  queueService?: FakeQueueService;
  cryptoService?: FakeCryptographyService;
}

export interface LogisticsHarness {
  cart: Cart;
  order: Order;
  cartRepository: InMemoryCartRepository;
  orderRepository: InMemoryOrderRepository;
  paymentRepository: InMemoryPaymentRepository;
  fulfillmentRepository: InMemoryFulfillmentRepository;
  notificationOutboxRepository: InMemoryNotificationOutboxRepository;
  logisticsService: FakeLogisticsService;
  queueService: FakeQueueService;
  cryptoService: FakeCryptographyService;
  auditLogService: InMemoryAuditLogService;
  retrieveDynamicShippingQuotes: RetrieveDynamicShippingQuotesUseCase;
  selectShippingOption: SelectShippingOptionUseCase;
  dispatchOrderFulfillment: DispatchOrderFulfillmentUseCase;
  processCourierTrackingEvent: ProcessCourierTrackingEventUseCase;
  queueLogisticsEvent: QueueLogisticsEventUseCase;
  verifyLogisticsEventSignature: VerifyLogisticsEventSignatureUseCase;
}

export function createLogisticsHarness(
  options: LogisticsHarnessOptions = {},
): LogisticsHarness {
  const order = options.order ?? buildDispatchableOrder();
  const cart = options.cart ?? buildCheckoutCart({ id: "cart-1" });

  const cartRepository = options.cartRepository ?? new InMemoryCartRepository();
  cartRepository.seed(cart);

  const orderRepository = options.orderRepository ?? new InMemoryOrderRepository();
  orderRepository.seed(order);

  const fulfillmentRepository =
    options.fulfillmentRepository ?? new InMemoryFulfillmentRepository();
  const paymentRepository =
    options.paymentRepository ?? new InMemoryPaymentRepository();
  const notificationOutboxRepository = new InMemoryNotificationOutboxRepository();

  const logisticsService = options.logisticsService ?? new FakeLogisticsService();
  const queueService = options.queueService ?? new FakeQueueService();
  const cryptoService = options.cryptoService ?? new FakeCryptographyService();
  const auditLogService = new InMemoryAuditLogService();
  const idGenerator = new SequenceIdGenerator();
  const logger = new NoopLogger();
  const transactionManager =
    options.transactionManager ?? new InMemoryTransactionManager();

  const retrieveDynamicShippingQuotes = new RetrieveDynamicShippingQuotesUseCase(
    cartRepository,
    logisticsService,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

  const selectShippingOption = new SelectShippingOptionUseCase(
    cartRepository,
    paymentRepository,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
  );

  const dispatchOrderFulfillment = new DispatchOrderFulfillmentUseCase(
    orderRepository,
    fulfillmentRepository,
    logisticsService,
    auditLogService,
    idGenerator,
    logger,
    transactionManager,
    notificationOutboxRepository,
  );

  const processCourierTrackingEvent = new ProcessCourierTrackingEventUseCase(
    fulfillmentRepository,
    transactionManager,
    auditLogService,
    idGenerator,
    logger,
    orderRepository,
    notificationOutboxRepository,
  );

  const queueLogisticsEvent = new QueueLogisticsEventUseCase(
    queueService,
    auditLogService,
    idGenerator,
    logger,
  );

  const verifyLogisticsEventSignature = new VerifyLogisticsEventSignatureUseCase(
    cryptoService,
    auditLogService,
    idGenerator,
    logger,
  );

  return {
    cart,
    order,
    cartRepository,
    orderRepository,
    paymentRepository,
    fulfillmentRepository,
    notificationOutboxRepository,
    logisticsService,
    queueService,
    cryptoService,
    auditLogService,
    retrieveDynamicShippingQuotes,
    selectShippingOption,
    dispatchOrderFulfillment,
    processCourierTrackingEvent,
    queueLogisticsEvent,
    verifyLogisticsEventSignature,
  };
}

// ---------------------------------------------------------------------------
// Dispatch fixtures
// ---------------------------------------------------------------------------

export interface DispatchOrderOptions {
  id?: string;
  cartId?: string;
  customerId?: string;
  transactionReference?: string | null;
  shippingSnapshot?: OrderShippingSnapshot | null;
  fulfillmentStatus?: Order["fulfillmentStatus"];
  fulfillments?: unknown[];
}

/**
 * The frozen provider-neutral shipping snapshot a finalized order carries.
 * Request token, selected courier/service/amount, destination (with the email
 * dispatch validates), and parcel items — everything Shipbubble needs, and
 * nothing the cart can later change.
 */
export function buildDispatchShippingSnapshot(
  overrides: Partial<OrderShippingSnapshot> = {},
): OrderShippingSnapshot {
  const base: OrderShippingSnapshot = {
    requestToken: "request-token-1",
    selection: {
      quoteId: "quote-1",
      courierId: "courier-1",
      serviceCode: "SC-EXPRESS",
      serviceLevel: "Express",
      amountMinor: 2500,
      currency: "ngn",
      etaDays: 3,
    },
    destination: {
      name: "Ada Okafor",
      email: "buyer@example.com",
      phone: "+2348000000000",
      company: null,
      line1: "1 Marina Street",
      line2: null,
      city: "Lagos",
      state: "Lagos",
      postalCode: "101001",
      countryCode: "NG",
    },
    parcelItems: [
      {
        lineItemId: "line-1",
        title: "Classic Tee",
        description: null,
        quantity: 2,
        unitPriceMinor: 25000,
        weightKg: null,
      },
      {
        lineItemId: "line-2",
        title: "Canvas Belt",
        description: null,
        quantity: 1,
        unitPriceMinor: 10000,
        weightKg: null,
      },
    ],
    dimensions: null,
  };
  return {
    ...base,
    ...overrides,
    selection: { ...base.selection, ...(overrides.selection ?? {}) },
    destination: { ...base.destination, ...(overrides.destination ?? {}) },
    parcelItems: overrides.parcelItems ?? base.parcelItems,
  };
}

/**
 * The canonical dispatchable order: finalized (payment captured, transaction
 * reference set), unfulfilled, and carrying the frozen shipping snapshot.
 * `fulfillments` may be passed to model DURABLE rehydration (a fresh Order
 * rehydrated from a DB row — the entity's `_fulfillments` is private, so a
 * marker can only enter via the constructor).
 */
export function buildDispatchableOrder(
  options: DispatchOrderOptions = {},
): Order {
  return new Order({
    id: options.id ?? "order-1",
    cartId: options.cartId ?? "cart-1",
    customerId: options.customerId ?? "customer-1",
    totalAmountMinor: 61000,
    currency: "ngn",
    subtotalMinor: 60000,
    discountMinor: 5000,
    taxMinor: 3000,
    shippingMinor: 2500,
    insuranceMinor: 500,
    transactionReference:
      options.transactionReference === undefined
        ? "CLP-checkout-cart-1"
        : options.transactionReference,
    paymentStatus: "captured",
    fulfillmentStatus: options.fulfillmentStatus ?? "unfulfilled",
    shippingSnapshot:
      options.shippingSnapshot === undefined
        ? buildDispatchShippingSnapshot()
        : options.shippingSnapshot,
    fulfillments: options.fulfillments as Order["fulfillments"],
  });
}

// ---------------------------------------------------------------------------
// Provider event helpers
// ---------------------------------------------------------------------------

export interface WebhookBodyOptions {
  id?: string;
  event?: string;
  orderId?: string;
  trackingNumber?: string;
  courier?: string;
  status?: string;
  eventTime?: string;
}

/**
 * A representative Shipbubble webhook envelope. Tests always sign the RAW bytes
 * of this body — never a JSON.parse/re-stringify round trip — mirroring the
 * production order (verify raw body BEFORE parsing).
 */
export function buildWebhookBody(
  options: WebhookBodyOptions = {},
): Buffer {
  const body = {
    id: options.id ?? "evt-1",
    event: options.event ?? "shipment.created",
    data: {
      order_id: options.orderId ?? "SB-123",
      tracking_number: options.trackingNumber ?? "TRK-1",
      courier: options.courier ?? "DHL",
      status: options.status ?? "in_transit",
      event_time: options.eventTime ?? "2026-08-15T10:00:00Z",
    },
  };
  return Buffer.from(JSON.stringify(body));
}

export type LogisticsEventOverrides = Partial<LogisticsEventJobPayload>;

/**
 * A provider-neutral logistics event (the queue contract the worker consumes).
 */
export function buildLogisticsEvent(
  overrides: LogisticsEventOverrides = {},
): LogisticsEventJobPayload {
  return {
    provider: "shipbubble",
    eventKey: "shipbubble:evt-1",
    eventType: "tracking.status_changed",
    providerShipmentId: "SB-123",
    trackingNumber: "TRK-1",
    courier: "DHL",
    status: "in_transit",
    occurredAt: "2026-08-15T10:00:00Z",
    ...overrides,
  };
}

/**
 * The raw `ProviderLogisticsEvent` the producer use case accepts (what the
 * Shipbubble mapper emits into the application boundary).
 */
export function buildProviderLogisticsEvent(
  overrides: Partial<ProviderLogisticsEvent> = {},
): ProviderLogisticsEvent {
  return {
    provider: "shipbubble",
    eventKey: "shipbubble:evt-1",
    eventType: "delivery.completed",
    providerShipmentId: "SB-123",
    trackingNumber: "TRK-1",
    courier: "DHL",
    status: "delivered",
    occurredAt: "2026-08-15T10:00:00Z",
    ...overrides,
  };
}

/** A server-persisted shipping quote (provider selection fields included). */
export function buildShippingQuote(
  overrides: Partial<ShippingQuote> = {},
): ShippingQuote {
  return {
    id: "quote-a",
    serviceLevel: "Express",
    amountMinor: 2500,
    currency: "ngn",
    etaDays: 3,
    courierId: "courier-1",
    serviceCode: "SC-EXPRESS",
    requestToken: "token-a",
    ...overrides,
  };
}
