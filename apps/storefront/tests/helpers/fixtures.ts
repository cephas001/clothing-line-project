// apps/storefront/tests/helpers/fixtures.ts
//
// Contract-shaped fixtures for the storefront service-layer tests. Every
// fixture is typed against `@clothing-line-project/shared-types` so the test
// payloads match the OpenAPI contract the client parses — the storefront
// service layer and the test fixtures share ONE source of truth.

import type {
  Address,
  AuthenticateCustomerResponse,
  Cart,
  CartLineItem,
  Category,
  Customer,
  Order,
  PaymentSessionResponse,
  Product,
  ProductMedia,
  ProductVariant,
  ShippingOptionSelectedResponse,
  ShippingQuote,
} from "@clothing-line-project/shared-types";

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq.toString().padStart(3, "0")}`;
}

export function makeMedia(url: string, sortOrder: number, kind = "image"): ProductMedia {
  return { id: nextId("media"), url, kind, altText: null, sortOrder };
}

export function makeVariant(
  overrides: Partial<ProductVariant> = {},
): ProductVariant {
  return {
    id: nextId("var"),
    productId: nextId("prod"),
    sku: "TEST-SKU",
    inventoryQuantity: 5,
    allowBackorder: false,
    version: 1,
    priceMinor: 15000,
    ...overrides,
  };
}

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: nextId("prod"),
    title: "Test Jacket",
    handle: "test-jacket",
    description: "A fixture product.",
    categoryIds: [],
    media: [makeMedia("/images/a.jpg", 0), makeMedia("/images/b.jpg", 1)],
    variants: [makeVariant()],
    ...overrides,
  };
}

export function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: nextId("cat"),
    name: "Jackets",
    parentCategoryId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeCartLine(overrides: Partial<CartLineItem> = {}): CartLineItem {
  return {
    id: nextId("line"),
    cartId: nextId("cart"),
    variantId: nextId("var"),
    title: null,
    quantity: 2,
    unitPriceMinor: 15000,
    lineTotalMinor: 30000,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeCart(overrides: Partial<Cart> = {}): Cart {
  const id = nextId("cart");
  return {
    id,
    regionId: "reg-test",
    salesChannelId: "channel-test",
    customerId: null,
    email: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    countryCode: "NG",
    currency: "NGN",
    taxAmountMinor: 3500,
    status: "active",
    cartTotalMinor: 33500,
    items: [makeCartLine({ cartId: id })],
    ...overrides,
  };
}

export function makeQuote(overrides: Partial<ShippingQuote> = {}): ShippingQuote {
  return {
    id: nextId("quote"),
    serviceLevel: "standard",
    amountMinor: 3000,
    currency: "NGN",
    etaDays: 3,
    ...overrides,
  };
}

export function makeShippingOptionSelected(
  overrides: Partial<ShippingOptionSelectedResponse> = {},
): ShippingOptionSelectedResponse {
  return {
    quoteId: nextId("quote"),
    serviceLevel: "standard",
    amountMinor: 3000,
    currency: "NGN",
    etaDays: 3,
    ...overrides,
  };
}

export function makePaymentSession(
  overrides: Partial<PaymentSessionResponse> = {},
): PaymentSessionResponse {
  return {
    authorizationUrl: "https://gateway.test/checkout/abc123",
    reference: nextId("ref"),
    ...overrides,
  };
}

export function makeAuthResponse(
  overrides: Partial<AuthenticateCustomerResponse> = {},
): AuthenticateCustomerResponse {
  return { accessToken: "jwt.test.token", ...overrides };
}

export function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: nextId("cust"),
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
    activeCartId: null,
    registeredAt: "2026-01-01T00:00:00.000Z",
    phone: null,
    addresses: [],
    ...overrides,
  };
}

export function makeAddress(overrides: Partial<Address> = {}): Address {
  return {
    id: nextId("addr"),
    firstName: "Ada",
    lastName: "Lovelace",
    phone: "+2348000000000",
    company: undefined,
    line1: "1 Test Street",
    line2: undefined,
    city: "Lagos",
    state: "LA",
    postalCode: "100001",
    countryCode: "NG",
    isDefault: false,
    ...overrides,
  };
}

export function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: nextId("ord"),
    cartId: nextId("cart"),
    customerId: nextId("cust"),
    totalAmountMinor: 40000,
    currency: "NGN",
    subtotalMinor: 33500,
    discountMinor: 0,
    taxMinor: 3500,
    shippingMinor: 3000,
    insuranceMinor: 0,
    fulfillmentStatus: "partially_fulfilled",
    paymentStatus: "captured",
    transactionReference: nextId("trx"),
    paymentStatusReason: null,
    paymentStatusUpdatedAt: "2026-01-02T00:00:00.000Z",
    flaggedForReview: false,
    flagReason: null,
    riskScore: null,
    flaggedAt: null,
    fulfillmentHaltedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lineItems: [
      {
        id: nextId("oline"),
        variantId: nextId("var"),
        quantity: 2,
        unitPriceMinor: 15000,
        fulfilledQuantity: 1,
      },
    ],
    availableVariants: [{ id: nextId("var"), unitPriceMinor: 15000 }],
    fulfillments: [
      {
        id: nextId("ful"),
        orderId: nextId("ord"),
        trackingNumber: "TRACK-001",
        courier: "Test Express",
        labelUrl: "https://shipping.test/label.pdf",
        serviceLevel: "standard",
        status: "in_transit",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    pendingReturns: [],
    ...overrides,
  };
}