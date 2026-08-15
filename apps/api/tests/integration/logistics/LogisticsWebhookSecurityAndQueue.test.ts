// apps/api/tests/integration/logistics/LogisticsWebhookSecurityAndQueue.test.ts
//
// L6 Part 3 — logistics webhook security + typed idempotent queue.
//
// Proves the inbound boundary is sealed:
//   - the HMAC is verified against the RAW request bytes BEFORE any JSON
//     parsing, fails closed, and never logs the secret/signature;
//   - the provider mapper emits a provider-neutral event with a deterministic
//     eventKey and NO envelope leakage;
//   - the producer enqueues ONLY the typed internal contract to the shared
//     logistics queue, keyed by eventKey (one logical event = one job), with
//     retries — no secrets ever enter the payload;
//   - malformed payloads are permanent VALIDATION_ERRORs, never enqueued.

import { RepositoryErrorCode } from "@api/domain/interfaces/shared/errors/RepositoryError";
import { ShipbubbleWebhookPayloadMapper } from "@api/infrastructure/services/ShipbubbleWebhookPayloadMapper";
import {
  parseLogisticsEventJobPayload,
  QUEUE_NAMES,
} from "@api/domain/shared/jobs";
import {
  buildProviderLogisticsEvent,
  buildWebhookBody,
  createLogisticsHarness,
} from "./logisticsHarness";
import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";

const SECRET = "whsec_logistics_test_secret";

describe("L6 Part 3 — logistics webhook signature security", () => {
  it("verifies a valid HMAC-SHA512 signature", () => {
    const h = createLogisticsHarness();
    const body = buildWebhookBody();
    const signature = h.cryptoService.sign(body, SECRET);

    h.verifyLogisticsEventSignature.execute({
      rawBody: body,
      signatureHeader: signature,
      secretKey: SECRET,
    });

    expect(h.cryptoService.hmacCalls.length).toBeGreaterThan(0);
    expect(h.cryptoService.compareCalls).toBeGreaterThan(0);
  });

  it("fails closed on a tampered body, wrong secret, missing header or missing secret", () => {
    const h = createLogisticsHarness();
    const body = buildWebhookBody();
    const signature = h.cryptoService.sign(body, SECRET);

    // Tampered body (same signature) — the raw bytes differ.
    const tampered = buildWebhookBody({ status: "delivered" });
    expect(() =>
      h.verifyLogisticsEventSignature.execute({
        rawBody: tampered,
        signatureHeader: signature,
        secretKey: SECRET,
      }),
    ).toThrowWithCode("LOGISTICS_VERIFICATION_FAILED");

    // Wrong secret.
    expect(() =>
      h.verifyLogisticsEventSignature.execute({
        rawBody: body,
        signatureHeader: h.cryptoService.sign(body, "other-secret"),
        secretKey: SECRET,
      }),
    ).toThrowWithCode("LOGISTICS_VERIFICATION_FAILED");

    // Missing header.
    expect(() =>
      h.verifyLogisticsEventSignature.execute({
        rawBody: body,
        signatureHeader: "",
        secretKey: SECRET,
      }),
    ).toThrowWithCode("LOGISTICS_VERIFICATION_FAILED");

    // Missing secret.
    expect(() =>
      h.verifyLogisticsEventSignature.execute({
        rawBody: body,
        signatureHeader: signature,
        secretKey: "",
      }),
    ).toThrowWithCode("LOGISTICS_VERIFICATION_FAILED");

    // Invalid raw body.
    expect(() =>
      h.verifyLogisticsEventSignature.execute({
        rawBody: "not-a-buffer" as unknown as Buffer,
        signatureHeader: signature,
        secretKey: SECRET,
      }),
    ).toThrowWithCode("LOGISTICS_VERIFICATION_FAILED");
  });

  it("computes the HMAC over the RAW bytes before any JSON parsing", () => {
    const h = createLogisticsHarness();
    const raw = buildWebhookBody();
    const signature = h.cryptoService.sign(raw, SECRET);

    h.verifyLogisticsEventSignature.execute({
      rawBody: raw,
      signatureHeader: signature,
      secretKey: SECRET,
    });

    // The verification hashed the exact raw bytes, never a re-serialized object.
    const lastCall = h.cryptoService.hmacCalls[h.cryptoService.hmacCalls.length - 1];
    expect(lastCall.payload.equals(raw)).toBe(true);
  });
});

describe("L6 Part 3 — provider webhook mapper", () => {
  it("maps the raw envelope to a provider-neutral event and never leaks the envelope", () => {
    const mapper = new ShipbubbleWebhookPayloadMapper();
    const event = mapper.parseAndMap(
      buildWebhookBody({
        id: "evt-1",
        event: "shipment.created",
        orderId: "SB-123",
        trackingNumber: "TRK-1",
        courier: "DHL",
        status: "in_transit",
      }),
    );

    expect(event.provider).toBe("shipbubble");
    expect(event.providerShipmentId).toBe("SB-123");
    expect(event.trackingNumber).toBe("TRK-1");
    expect(event.eventType).toBe("shipment.created");
    expect(event.eventKey).toBe("shipbubble:evt-1");

    // The provider envelope itself never crosses the application boundary.
    const record = event as unknown as Record<string, unknown>;
    expect(record.data).toBeUndefined();
    expect(record.envelope).toBeUndefined();
    expect(record.order_id).toBeUndefined();
    expect(record.event).toBeUndefined();
  });

  it("derives deterministic event keys (stable identity, no randomness)", () => {
    const mapper = new ShipbubbleWebhookPayloadMapper();

    const delivered = mapper.parseAndMap(
      buildWebhookBody({ id: "evt-1", event: "delivery.completed", status: "delivered" }),
    );
    const deliveredAgain = mapper.parseAndMap(
      buildWebhookBody({ id: "evt-1", event: "delivery.completed", status: "delivered" }),
    );
    expect(delivered.eventKey).toBe(deliveredAgain.eventKey);

    // A different logical event of the same shipment yields a different key.
    const outForDelivery = mapper.parseAndMap(
      buildWebhookBody({ id: "evt-2", event: "delivery.attempted", status: "out_for_delivery" }),
    );
    expect(outForDelivery.eventKey).not.toBe(delivered.eventKey);
  });
});

describe("L6 Part 3 — logistics event queue contract", () => {
  it("enqueues ONLY the typed internal payload to the shared queue, keyed by eventKey", async () => {
    const h = createLogisticsHarness();
    const event = buildProviderLogisticsEvent();

    await h.queueLogisticsEvent.execute({ logisticsEvent: event });

    expect(h.queueService.jobs).toHaveLength(1);
    const job = h.queueService.jobs[0];
    expect(job.queueName).toBe(QUEUE_NAMES.logisticsEvents);
    expect(job.queueName).toBe("logistics-events-queue");
    expect(job.options?.jobId).toBe("shipbubble:evt-1");
    expect(job.options?.attempts).toBe(5);

    // The payload is EXACTLY the typed contract — no API keys, auth headers,
    // raw webhook bodies, or provider secrets.
    expect(job.payload).toEqual({
      provider: "shipbubble",
      eventKey: "shipbubble:evt-1",
      eventType: "delivery.completed",
      providerShipmentId: "SB-123",
      trackingNumber: "TRK-1",
      courier: "DHL",
      status: "delivered",
      occurredAt: "2026-08-15T10:00:00Z",
    });
    const serialized = JSON.stringify(job.payload);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("x-shipbubble");
    expect(h.auditLogService.actions().includes("LOGISTICS_EVENT_QUEUED")).toBe(true);
  });

  it("collapses duplicate deliveries onto the SAME job (idempotent eventKey)", async () => {
    const h = createLogisticsHarness();
    const event = buildProviderLogisticsEvent();

    await h.queueLogisticsEvent.execute({ logisticsEvent: event });
    await h.queueLogisticsEvent.execute({ logisticsEvent: event });

    expect(h.queueService.jobs).toHaveLength(1);
    expect(h.auditLogService.actions().includes("LOGISTICS_EVENT_ALREADY_QUEUED")).toBe(true);
  });

  it("rejects malformed producer payloads with VALIDATION_ERROR and enqueues nothing", async () => {
    const h = createLogisticsHarness();

    await expect(() =>
      h.queueLogisticsEvent.execute({
        logisticsEvent: {
          provider: "shipbubble",
          eventKey: "",
          eventType: "delivery.completed",
          providerShipmentId: "SB-1",
        } as never,
      }),
    ).rejectsWithCode("VALIDATION_ERROR");
    expect(h.queueService.jobs).toHaveLength(0);
  });

  it("worker-side parser rejects unknown providers, unknown types, and bad dates", () => {
    expect(() =>
      parseLogisticsEventJobPayload({
        provider: "fedex",
        eventKey: "k",
        eventType: "delivery.completed",
        providerShipmentId: "SB-1",
      }),
    ).toThrowWithCode("VALIDATION_ERROR");

    expect(() =>
      parseLogisticsEventJobPayload({
        provider: "shipbubble",
        eventKey: "k",
        eventType: "made.up",
        providerShipmentId: "SB-1",
      }),
    ).toThrowWithCode("VALIDATION_ERROR");

    expect(() =>
      parseLogisticsEventJobPayload({
        provider: "shipbubble",
        eventKey: "k",
        eventType: "delivery.completed",
        providerShipmentId: "SB-1",
        occurredAt: "not-a-date",
      }),
    ).toThrowWithCode("VALIDATION_ERROR");
  });

  it("maps queue connection/timeout failures to INTERNAL_ERROR", async () => {
    const h = createLogisticsHarness();
    const event = buildProviderLogisticsEvent();

    h.queueService.failWithCode = RepositoryErrorCode.CONNECTION;
    await expect(() =>
      h.queueLogisticsEvent.execute({ logisticsEvent: event }),
    ).rejectsWithCode("INTERNAL_ERROR");

    h.queueService.failWithCode = RepositoryErrorCode.TIMEOUT;
    await expect(() =>
      h.queueLogisticsEvent.execute({ logisticsEvent: event }),
    ).rejectsWithCode("INTERNAL_ERROR");
  });
});