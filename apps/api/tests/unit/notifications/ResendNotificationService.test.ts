// apps/api/tests/unit/notifications/ResendNotificationService.test.ts
//
// UNIT TESTS — the concrete Resend adapter (security + failure injection).
//
// SECURITY PROOFS (L8 PART 20/21/16):
//   - fail-closed construction: no API key, no from-email, no logger => the
//     adapter cannot be built (CONFIGURATION);
//   - the API key NEVER appears in any log message/meta and NEVER in any error
//     message — only on the wire as the Authorization header;
//   - the recipient is never logged, and preference suppression stops the POST
//     before any provider contact.
//
// FAILURE INJECTION (L8 PART 25):
//   - provider timeout (AbortError)      -> RepositoryErrorCode.TIMEOUT
//   - network failure                    -> RepositoryErrorCode.CONNECTION
//   - HTTP 500                           -> UNKNOWN / GATEWAY_ERROR
//   - HTTP 401                           -> UNKNOWN / GATEWAY_AUTH
//   - HTTP 4xx gateway rejection         -> UNKNOWN / GATEWAY_REJECTED
//   - non-JSON / id-less success         -> UNKNOWN / MALFORMED_RESPONSE
//   - corrupt financial value            -> UNKNOWN / INVALID_PAYLOAD
//
// Every failure is a ResendNotificationError (RepositoryError subclass) so the
// use-case layer can map it onto a stable DomainError code — the adapter never
// throws a DomainError and never leaks raw fetch errors.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import type { StructuredMeta } from "@api/domain/shared/contracts";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";
import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { PaymentConfirmationNotification } from "@api/domain/shared/notifications";
import {
  ResendNotificationError,
  ResendNotificationService,
  type ResendHttpClient,
} from "@api/infrastructure/services/ResendNotificationService";

const API_KEY = "re_test_super_secret_key_123";
const FROM_EMAIL = "no-reply@example.com";

class RecordingLogger implements ILogger {
  readonly entries: Array<{ level: string; message: string; meta?: StructuredMeta }> = [];
  debug(message: string, meta?: StructuredMeta): void {
    this.entries.push({ level: "debug", message, meta });
  }
  info(message: string, meta?: StructuredMeta): void {
    this.entries.push({ level: "info", message, meta });
  }
  warn(message: string, meta?: StructuredMeta): void {
    this.entries.push({ level: "warn", message, meta });
  }
  error(message: string, meta?: StructuredMeta): void {
    this.entries.push({ level: "error", message, meta });
  }
}

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  jsonThrows?: boolean;
}

function makeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 201;
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => {
      if (init.jsonThrows) {
        throw new Error("invalid json");
      }
      return init.body;
    },
  } as unknown as Response;
}

function buildIntent(): PaymentConfirmationNotification {
  return {
    recipient: { email: "buyer@example.com", name: "Ada Okafor" },
    order: {
      orderId: "order-1",
      cartId: "cart-1",
      customerId: "customer-1",
      currency: "ngn",
      createdAt: "2026-08-15T10:00:00.000Z",
    },
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
    lineItems: [{ id: "line-1", variantId: "variant-1", quantity: 2, unitPriceMinor: 25000 }],
  };
}

interface ClientHarness {
  logger: RecordingLogger;
  requests: Array<{ url: string; init: RequestInit }>;
  service: ResendNotificationService;
}

function makeHarness(
  httpClient: ResendHttpClient,
  options: { passwordResetUrl?: string | null } = {},
): ClientHarness {
  const logger = new RecordingLogger();
  const requests: ClientHarness["requests"] = [];
  const wrapped: ResendHttpClient = (url, init) => {
    requests.push({ url, init });
    return httpClient(url, init);
  };
  const service = new ResendNotificationService({
    apiKey: API_KEY,
    fromEmail: FROM_EMAIL,
    fromName: "Clothing Line",
    logger,
    httpClient: wrapped,
    passwordResetUrl: options.passwordResetUrl,
  });
  return { logger, requests, service };
}

describe("Resend adapter — fail-closed construction (security)", () => {
  it("refuses to build without an API key", () => {
    expect(
      () =>
        new ResendNotificationService({
          apiKey: " ",
          fromEmail: FROM_EMAIL,
          logger: new RecordingLogger(),
        }),
    ).toThrowWithCode(RepositoryErrorCode.UNKNOWN);
  });

  it("refuses to build without a from email", () => {
    expect(
      () =>
        new ResendNotificationService({
          apiKey: API_KEY,
          fromEmail: "",
          logger: new RecordingLogger(),
        }),
    ).toThrowWithCode(RepositoryErrorCode.UNKNOWN);
  });

  it("refuses to build without a logger", () => {
    expect(
      () =>
        new ResendNotificationService({
          apiKey: API_KEY,
          fromEmail: FROM_EMAIL,
          logger: undefined as never,
        }),
    ).toThrowWithCode(RepositoryErrorCode.UNKNOWN);
  });

  it("refuses a non-HTTPS base URL (provider traffic is always encrypted)", () => {
    expect(
      () =>
        new ResendNotificationService({
          apiKey: API_KEY,
          fromEmail: FROM_EMAIL,
          baseUrl: "http://api.resend.com",
          logger: new RecordingLogger(),
        }),
    ).toThrowWithCode(RepositoryErrorCode.UNKNOWN);
  });
});

describe("Resend adapter — successful dispatch", () => {
  it("POSTs /emails with the key only on the wire, then logs only safe metadata", async () => {
    const h = makeHarness(async () => makeResponse({ status: 201, body: { id: "msg-1" } }));

    await h.service.sendPaymentConfirmation(buildIntent());

    expect(h.requests).toHaveLength(1);
    const request = h.requests[0];
    expect(request.url).toBe("https://api.resend.com/emails");
    const headers = request.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);

    // Body carries from/to/subject/html — the provider-neutral render.
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    expect(body.to).toEqual(["buyer@example.com"]);
    expect(String(body.html)).toContain("\u20a6610.00");

    // Audit metadata is SAFE: no apiKey, no Authorization value, no recipient.
    const serializedLog = JSON.stringify(h.logger.entries);
    expect(serializedLog).not.toContain(API_KEY);
    expect(serializedLog).not.toContain("Bearer ");
    expect(serializedLog).not.toContain("buyer@example.com");
    expect(serializedLog).toContain('"providerMessageId":"msg-1"');
  });

  it("builds the password-reset link from the configured base URL and encodes the token", async () => {
    const h = makeHarness(
      async () => makeResponse({ status: 201, body: { id: "msg-2" } }),
      { passwordResetUrl: "https://shop.example.com/reset-password?token=" },
    );

    await h.service.sendPasswordReset({
      recipient: { email: "buyer@example.com" },
      customerId: "customer-1",
      token: "abc 123",
      expiresInSeconds: 3600,
      requestedAt: "2026-08-15T10:00:00.000Z",
    });

    const body = JSON.parse(String(h.requests[0].init.body)) as { html: string };
    expect(body.html).toContain("https://shop.example.com/reset-password?token=abc%20123");
  });
});

describe("Resend adapter — API key is NEVER logged (security, all paths)", () => {
  it("does not log the key on a network failure", async () => {
    const h = makeHarness(async () => {
      throw new Error("socket hang up");
    });

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ResendNotificationError);
    }
    expect(JSON.stringify(h.logger.entries)).not.toContain(API_KEY);
    expect(JSON.stringify(h.logger.entries)).not.toContain("Bearer");
  });

  it("does not log the key on an HTTP 500", async () => {
    const h = makeHarness(async () => makeResponse({ status: 500, body: {} }));

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ResendNotificationError);
    }
    expect(JSON.stringify(h.logger.entries)).not.toContain(API_KEY);
  });

  it("does not embed the key in the surfaced error message", async () => {
    const h = makeHarness(async () => {
      throw new Error(`Bearer ${API_KEY} leaked by transport`);
    });

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect(String(err)).not.toContain(API_KEY);
    }
  });
});

describe("Resend adapter — failure injection (provider timeouts / 500s / network)", () => {
  it("classifies a provider TIMEOUT as RepositoryErrorCode.TIMEOUT", async () => {
    const h = makeHarness(async () => {
      const err = new Error("The operation was aborted") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    });

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ResendNotificationError);
      expect((err as ResendNotificationError).code).toBe(RepositoryErrorCode.TIMEOUT);
      expect((err as ResendNotificationError).category).toBe("TIMEOUT");
    }
  });

  it("classifies a NETWORK failure as RepositoryErrorCode.CONNECTION", async () => {
    const h = makeHarness(async () => {
      throw new Error("failed to fetch");
    });

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect((err as ResendNotificationError).code).toBe(RepositoryErrorCode.CONNECTION);
      expect((err as ResendNotificationError).category).toBe("NETWORK");
    }
  });

  it("classifies an HTTP 500 as GATEWAY_ERROR (retry-eligible), never 'declined'", async () => {
    const h = makeHarness(async () => makeResponse({ status: 500, body: {} }));

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect((err as ResendNotificationError).category).toBe("GATEWAY_ERROR");
      expect((err as ResendNotificationError).code).toBe(RepositoryErrorCode.UNKNOWN);
    }
  });

  it("classifies an HTTP 401 as GATEWAY_AUTH (credential problem is distinct)", async () => {
    const h = makeHarness(async () => makeResponse({ status: 401, body: {} }));

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect((err as ResendNotificationError).category).toBe("GATEWAY_AUTH");
    }
  });

  it("surfaces the gateway's human-safe rejection message for a 4xx", async () => {
    const h = makeHarness(async () =>
      makeResponse({ status: 422, body: { message: "Invalid 'from' address" } }),
    );

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect((err as ResendNotificationError).category).toBe("GATEWAY_REJECTED");
      expect((err as ResendNotificationError).message).toContain("Invalid 'from' address");
    }
  });

  it("rejects a non-JSON success response as MALFORMED_RESPONSE", async () => {
    const h = makeHarness(async () =>
      makeResponse({ status: 201, jsonThrows: true }),
    );

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect((err as ResendNotificationError).category).toBe("MALFORMED_RESPONSE");
    }
  });

  it("rejects a success response without a provider message id", async () => {
    const h = makeHarness(async () => makeResponse({ status: 201, body: {} }));

    try {
      await h.service.sendPaymentConfirmation(buildIntent());
      expect(true).toBe(false);
    } catch (err) {
      expect((err as ResendNotificationError).category).toBe("MALFORMED_RESPONSE");
    }
  });

  it("rejects a corrupt financial value as INVALID_PAYLOAD (frozen-value guard)", async () => {
    const h = makeHarness(async () => makeResponse({ status: 201, body: { id: "x" } }));
    const intent = buildIntent();
    intent.breakdown = { ...intent.breakdown, totalMinor: -5 };

    try {
      await h.service.sendPaymentConfirmation(intent);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as ResendNotificationError).category).toBe("INVALID_PAYLOAD");
    }
  });
});

describe("Resend adapter — recipient preference suppression", () => {
  it("never contacts the provider when the policy suppresses the intent", async () => {
    const logger = new RecordingLogger();
    let called = 0;
    const service = new ResendNotificationService({
      apiKey: API_KEY,
      fromEmail: FROM_EMAIL,
      logger,
      httpClient: async () => {
        called += 1;
        return makeResponse({ status: 201, body: { id: "x" } });
      },
      preferences: {
        isSuppressed: async () => true,
      },
    });

    await service.sendPaymentConfirmation(buildIntent());
    expect(called).toBe(0);
    // Suppression is recorded as a warn (outcome metadata), not sent.
    expect(JSON.stringify(logger.entries)).toContain("suppressed");
  });
});