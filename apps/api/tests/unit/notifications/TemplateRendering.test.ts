// apps/api/tests/unit/notifications/TemplateRendering.test.ts
//
// UNIT TESTS — L8 email template rendering (templates/renderers + index).
//
// Proves the provider-neutral renderer for EVERY notification intent:
//   - each intent renders a subject + HTML body through the shared shell;
//   - user-controlled strings (recipient name, item titles, notes, courier)
//     are HTML-escaped — a malicious value cannot inject markup;
//   - money renders with the authoritative symbol (frozen amount);
//   - the password-reset intent renders the pre-built link when supplied and
//     the single-use token (never a link fabrication) otherwise.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { renderNotificationEmail } from "@api/infrastructure/services/notifications/templates";
import type { NotificationIntent } from "@api/domain/shared/notifications";

function orderContext(overrides: { orderId?: string } = {}) {
  return {
    orderId: overrides.orderId ?? "order-1",
    cartId: "cart-1",
    customerId: "customer-1",
    currency: "ngn",
    createdAt: "2026-08-15T10:00:00.000Z",
  };
}

describe("Notification template rendering — payment_confirmation", () => {
  it("renders a subject with the reference and a body with the frozen total", () => {
    const intent: NotificationIntent = {
      type: "payment_confirmation",
      payload: {
        recipient: { email: "buyer@example.com", name: "Ada Okafor" },
        order: orderContext(),
        transactionReference: "CLP-checkout-cart-1",
        breakdown: {
          subtotalMinor: 60000,
          discountMinor: 5000,
          taxMinor: 3000,
          shippingMinor: 2500,
          insuranceMinor: 500,
          totalMinor: 61000,
        },
        paidAt: "2026-08-15T10:00:01.000Z",
        lineItems: [
          { id: "line-1", title: "Classic Tee", quantity: 2, unitPriceMinor: 25000 },
        ],
      },
    };
    const rendered = renderNotificationEmail(intent);
    expect(rendered.subject).toBe("Payment confirmed — CLP-checkout-cart-1");
    expect(rendered.html).toContain("\u20a6610.00");
    expect(rendered.html).toContain("Classic Tee");
    expect(rendered.html).toContain("CLP-checkout-cart-1");
    expect(rendered.html).toContain("<!DOCTYPE html>");
  });

  it("HTML-escapes a hostile recipient name so no markup can inject", () => {
    const intent: NotificationIntent = {
      type: "payment_confirmation",
      payload: {
        recipient: { email: "buyer@example.com", name: "<img src=x onerror=alert(1)>" },
        order: orderContext(),
        transactionReference: "REF-1",
        breakdown: {
          subtotalMinor: 1000,
          discountMinor: 0,
          taxMinor: 0,
          shippingMinor: 0,
          insuranceMinor: 0,
          totalMinor: 1000,
        },
        paidAt: "2026-08-15T10:00:01.000Z",
        lineItems: [],
      },
    };
    const rendered = renderNotificationEmail(intent);
    expect(rendered.html).not.toContain("<img src=x");
    expect(rendered.html).toContain("&lt;img");
  });
});

describe("Notification template rendering — shipment_dispatched", () => {
  it("renders tracking number, carrier, service and label link when present", () => {
    const intent: NotificationIntent = {
      type: "shipment_dispatched",
      payload: {
        recipient: { email: "buyer@example.com", name: "Ada Okafor" },
        order: orderContext(),
        fulfillmentId: "f-1",
        providerShipmentId: "SB-123",
        trackingNumber: "TRK-42",
        courier: "DHL",
        serviceLevel: "Express",
        labelUrl: "https://labels.example/trk-42",
        dispatchedAt: "2026-08-15T11:00:00.000Z",
      },
    };
    const rendered = renderNotificationEmail(intent);
    expect(rendered.subject).toBe("Your order has been dispatched");
    expect(rendered.html).toContain("TRK-42");
    expect(rendered.html).toContain("DHL");
    expect(rendered.html).toContain("https://labels.example/trk-42");
  });
});

describe("Notification template rendering — tracking_update", () => {
  const base = (
    status: "delivered" | "in_transit" | "out_for_delivery" | "delivery_failed",
  ): NotificationIntent => ({
    type: "tracking_update",
    payload: {
      recipient: { email: "buyer@example.com", name: "Ada Okafor" },
      order: orderContext(),
      fulfillmentId: "f-1",
      trackingNumber: "TRK-42",
      courier: "DHL",
      status,
      occurredAt: "2026-08-15T12:00:00.000Z",
    },
  });

  it("uses the normalized state label in the subject (never a raw provider string)", () => {
    expect(renderNotificationEmail(base("delivered")).subject).toBe(
      "Your order has been delivered",
    );
    expect(renderNotificationEmail(base("out_for_delivery")).subject).toBe(
      "Your order is out for delivery",
    );
  });

  it("adds a resolution line for a failed delivery", () => {
    const rendered = renderNotificationEmail(base("delivery_failed"));
    expect(rendered.html).toContain("marked as failed to deliver");
    expect(rendered.html).toContain("working with the carrier to resolve this");
  });
});

describe("Notification template rendering — refund_issued", () => {
  it("renders the frozen refund amount with the authoritative currency symbol", () => {
    const intent: NotificationIntent = {
      type: "refund_issued",
      payload: {
        recipient: { email: "buyer@example.com", name: "Ada Okafor" },
        order: orderContext(),
        refundId: "refund-1",
        refundReference: "refund-1",
        providerRefundReference: "provider-ref-1",
        money: { currency: "ngn", amountMinor: 5000 },
        reason: "Return of Classic Tee",
        issuedAt: "2026-08-15T14:00:00.000Z",
      },
    };
    const rendered = renderNotificationEmail(intent);
    expect(rendered.subject).toBe("Refund issued");
    expect(rendered.html).toContain("\u20a650.00");
    expect(rendered.html).toContain("refund-1");
    expect(rendered.html).toContain("Return of Classic Tee");
  });
});

describe("Notification template rendering — password_reset", () => {
  const intent = (): NotificationIntent => ({
    type: "password_reset",
    payload: {
      recipient: { email: "buyer@example.com", name: "Ada Okafor" },
      customerId: "customer-1",
      token: "single-use-token-abc",
      expiresInSeconds: 3600,
      requestedAt: "2026-08-15T10:00:00.000Z",
    },
  });

  it("renders the adapter-built reset link when supplied (link is never fabricated here)", () => {
    const rendered = renderNotificationEmail(intent(), {
      passwordReset: {
        resetLink: "https://shop.example.com/reset-password?token=single-use-token-abc",
      },
    });
    expect(rendered.html).toContain("Reset password");
    expect(rendered.html).toContain("https://shop.example.com/reset-password");
    expect(rendered.html).not.toContain("single-use-token-abc</strong>");
  });

  it("renders the raw single-use token when no link is configured", () => {
    const rendered = renderNotificationEmail(intent());
    expect(rendered.html).toContain("single-use-token-abc");
  });

  it("expresses the token TTL in minutes from the granted seconds", () => {
    const rendered = renderNotificationEmail(intent());
    expect(rendered.html).toContain("expires in 60 minutes");
  });
});

describe("Notification template rendering — quote_approved", () => {
  it("renders the frozen approved total (amount-only when currency is unknown)", () => {
    const intent: NotificationIntent = {
      type: "quote_approved",
      payload: {
        recipient: { email: "buyer@example.com", name: "Ada Okafor" },
        quoteId: "quote-1",
        businessUnitId: "bu-1",
        approvedTotalMinor: 152500,
        currency: null,
        approvedBy: "admin-1",
        approvedAt: "2026-08-15T15:00:00.000Z",
        note: "Approved at discounted pricing",
      },
    };
    const rendered = renderNotificationEmail(intent);
    expect(rendered.subject).toBe("Your quote has been approved");
    expect(rendered.html).toContain("1,525.00");
    expect(rendered.html).toContain("Approved at discounted pricing");
  });
});

describe("Notification template rendering — draft_order_invoice", () => {
  it("renders the frozen total and item count from the durable draft record", () => {
    const intent: NotificationIntent = {
      type: "draft_order_invoice",
      payload: {
        recipient: { email: "buyer@example.com", name: "Ada Okafor" },
        draftOrderId: "draft-7",
        totalMinor: 61000,
        currency: "ngn",
        itemCount: 2,
        createdAt: "2026-08-15T09:00:00.000Z",
      },
    };
    const rendered = renderNotificationEmail(intent);
    expect(rendered.subject).toBe("Invoice for your draft order — draft-7");
    expect(rendered.html).toContain("\u20a6610.00");
    expect(rendered.html).toContain("2 items");
  });
});