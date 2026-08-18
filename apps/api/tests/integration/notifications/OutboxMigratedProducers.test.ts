// apps/api/tests/integration/notifications/OutboxMigratedProducers.test.ts
//
// INTEGRATION TESTS — L8-R PART 3: the two direct-sync notifiers that were
// MIGRATED to the notification outbox:
//
//   - GenerateDraftOrderUseCase  (draft_order_invoice)
//   - ApproveB2BQuoteUseCase     (quote_approved)
//
// PROOFS:
//   1. The notification intent is appended INSIDE the business transaction —
//      an outbox write failure ROLLS BACK the whole unit of work (no draft
//      order, no approval, zero partial state).
//   2. Financial values in the intent come from the FROZEN persisted record
//      (`DraftOrderRecord.totalMinor`, `Quote.approvedTotalMinor`) — never
//      recomputed, and the recipient is the authoritative record email /
//      requester customer.email, never a request body.
//   3. A missing/unreadable requester skips the notification but NEVER fails
//      the business outcome.
//   4. `sendInvoice: false` creates the draft order with no outbox row.
//
// Structural note: both use cases now depend on INotificationOutboxRepository
// (+ ITransactionManager) instead of INotificationService — they no longer
// hold any direct provider-send dependency.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { GenerateDraftOrderUseCase } from "@api/use-cases/logistics/GenerateDraftOrderUseCase";
import { ApproveB2BQuoteUseCase } from "@api/use-cases/customers/ApproveB2BQuoteUseCase";
import { Quote } from "@api/domain/entities/Quote";
import { Customer } from "@api/domain/entities/Customer";
import { InMemoryDraftOrderRepository } from "../../fakes/InMemoryDraftOrderRepository";
import { InMemoryQuoteRepository } from "../../fakes/InMemoryQuoteRepository";
import { InMemoryCustomerRepository } from "../../fakes/InMemoryCustomerRepository";
import { InMemoryNotificationOutboxRepository } from "../../fakes/InMemoryNotificationOutboxRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import { NoopLogger } from "../../fakes/NoopLogger";
import { InMemoryTransactionManager } from "../../fakes/InMemoryTransactionManager";
import { SnapshotTransactionManager } from "../../fakes/SnapshotTransactionManager";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { NotificationIntent } from "@api/domain/shared/notifications";
import type { DraftOrderRecord } from "@api/domain/shared/contracts";

/** An outbox whose append throws — simulating a DB write failure. */
class FailingAppendOutbox extends InMemoryNotificationOutboxRepository {
  override async append(
    _id: string,
    _intent: NotificationIntent,
  ): Promise<void> {
    const error = new Error("outbox write failed") as RepositoryError;
    error.name = "RepositoryError";
    error.code = RepositoryErrorCode.LOCKED;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// GenerateDraftOrderUseCase
// ---------------------------------------------------------------------------

function draftOrderHarness(outbox: InMemoryNotificationOutboxRepository) {
  const draftOrderRepository = new InMemoryDraftOrderRepository();
  const transactionManager = new SnapshotTransactionManager([
    draftOrderRepository,
    outbox,
  ]);
  const audit = new InMemoryAuditLogService();
  const useCase = new GenerateDraftOrderUseCase(
    draftOrderRepository,
    outbox,
    audit,
    new SequenceIdGenerator(),
    new NoopLogger(),
    transactionManager,
  );
  return { draftOrderRepository, outbox, audit, useCase };
}

const DRAFT_ORDER_INPUT = {
  email: "BUYER@Example.com",
  items: [
    { title: "Oversized Tee", quantity: 2, unitPriceMinor: 15000 },
    { title: "Belt", quantity: 1, unitPriceMinor: 8000 },
  ],
  shippingAddress: { line1: "12 Marina St" },
  adminId: "admin-1",
  sendInvoice: true,
};

describe("GenerateDraftOrderUseCase — draft_order_invoice via the outbox", () => {
  it("persists the draft order and appends ONE invoice intent from the frozen record", async () => {
    const h = draftOrderHarness(new InMemoryNotificationOutboxRepository());

    const draftOrderId = await h.useCase.execute(DRAFT_ORDER_INPUT);

    // Draft order committed with the normalized (lowercased) email + frozen total.
    const record = h.draftOrderRepository.all[0] as DraftOrderRecord;
    expect(record.id).toBe(draftOrderId);
    expect(record.email).toBe("buyer@example.com");
    expect(record.totalMinor).toBe(38000);

    // EXACTLY one pending intent, carrying the FROZEN record values.
    expect(h.outbox.rows).toHaveLength(1);
    const row = h.outbox.rows[0];
    expect(row.intentType).toBe("draft_order_invoice");
    expect(row.status).toBe("pending");
    const payload = row.payload as { type: "draft_order_invoice"; payload: {
      recipient: { email: string };
      draftOrderId: string;
      totalMinor: number;
      currency: string | null;
      itemCount: number;
    } };
    expect(payload.type).toBe("draft_order_invoice");
    // Recipient + financial values come from the SAME frozen record.
    expect(payload.payload.recipient.email).toBe(record.email);
    expect(payload.payload.draftOrderId).toBe(record.id);
    expect(payload.payload.totalMinor).toBe(record.totalMinor);
    expect(payload.payload.totalMinor).toBe(38000);
    expect(payload.payload.itemCount).toBe(record.items.length);
    expect(payload.payload.currency).toBeNull();
  });

  it("creates the draft order with NO outbox row when sendInvoice is false", async () => {
    const h = draftOrderHarness(new InMemoryNotificationOutboxRepository());

    const draftOrderId = await h.useCase.execute({
      ...DRAFT_ORDER_INPUT,
      sendInvoice: false,
    });

    expect(h.draftOrderRepository.all).toHaveLength(1);
    expect(h.draftOrderRepository.all[0].id).toBe(draftOrderId);
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("an outbox append failure ROLLS BACK the whole unit of work — no draft order leaks", async () => {
    const outbox = new FailingAppendOutbox();
    const h = draftOrderHarness(outbox);

    await expect(() => h.useCase.execute(DRAFT_ORDER_INPUT)).rejectsWithCode(
      "INTERNAL_ERROR",
    );

    // All-or-nothing: the draft order save rolled back with the append.
    expect(h.draftOrderRepository.all).toHaveLength(0);
    expect(outbox.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ApproveB2BQuoteUseCase
// ---------------------------------------------------------------------------

function quoteHarness(outbox: InMemoryNotificationOutboxRepository) {
  const quoteRepository = new InMemoryQuoteRepository();
  const customerRepository = new InMemoryCustomerRepository();
  const transactionManager = new SnapshotTransactionManager([
    quoteRepository,
    customerRepository,
    outbox,
  ]);
  const audit = new InMemoryAuditLogService();
  const useCase = new ApproveB2BQuoteUseCase(
    quoteRepository,
    customerRepository,
    transactionManager,
    outbox,
    audit,
    new SequenceIdGenerator(),
    new NoopLogger(),
  );
  return { quoteRepository, customerRepository, outbox, audit, useCase };
}

function seededQuoteHarness(outbox: InMemoryNotificationOutboxRepository) {
  const h = quoteHarness(outbox);
  h.quoteRepository.seed(
    new Quote({
      id: "quote-1",
      cartId: "cart-1",
      cartSnapshotJson: JSON.stringify({ lineItems: [] }),
      businessUnitId: "bu-1",
      requestedByCustomerId: "customer-1",
      requestedAt: "2026-08-15T10:00:00.000Z",
    }),
  );
  h.customerRepository.seed(
    new Customer({
      id: "customer-1",
      firstName: "Ada",
      lastName: "Okafor",
      email: "Ada@Example.com",
    }),
  );
  return h;
}

const APPROVE_INPUT = {
  quoteId: "quote-1",
  adminId: "admin-1",
  approvedTotalMinor: 61000,
  approvalNote: "Approved at standard pricing",
};

describe("ApproveB2BQuoteUseCase — quote_approved via the outbox", () => {
  it("approves the quote and appends ONE intent from the frozen approved total + authoritative customer email", async () => {
    const h = seededQuoteHarness(new InMemoryNotificationOutboxRepository());

    await h.useCase.execute(APPROVE_INPUT);

    const approved = h.quoteRepository.all[0];
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedBy).toBe("admin-1");
    expect(approved.approvedTotalMinor).toBe(61000);

    // EXACTLY one pending intent; the financial value is the FROZEN record value.
    expect(h.outbox.rows).toHaveLength(1);
    const row = h.outbox.rows[0];
    expect(row.intentType).toBe("quote_approved");
    expect(row.status).toBe("pending");
    const payload = row.payload as { type: "quote_approved"; payload: {
      recipient: { email: string; name: string | null };
      quoteId: string;
      businessUnitId: string;
      approvedTotalMinor: number;
      approvedBy: string;
      note: string | null;
    } };
    expect(payload.type).toBe("quote_approved");
    expect(payload.payload.approvedTotalMinor).toBe(
      approved.approvedTotalMinor!,
    );
    expect(payload.payload.approvedTotalMinor).toBe(61000);
    // Recipient is the AUTHORITATIVE customer.email (normalized), not the input.
    expect(payload.payload.recipient.email).toBe("ada@example.com");
    expect(payload.payload.recipient.name).toBe("Ada Okafor");
    expect(payload.payload.quoteId).toBe("quote-1");
    expect(payload.payload.businessUnitId).toBe("bu-1");
    expect(payload.payload.approvedBy).toBe("admin-1");
    expect(payload.payload.note).toBe("Approved at standard pricing");
  });

  it("a missing requester record SKIPS the notification but still approves the quote", async () => {
    const h = quoteHarness(new InMemoryNotificationOutboxRepository());
    h.quoteRepository.seed(
      new Quote({
        id: "quote-1",
        cartId: "cart-1",
        cartSnapshotJson: JSON.stringify({ lineItems: [] }),
        businessUnitId: "bu-1",
        requestedByCustomerId: "customer-missing",
        requestedAt: "2026-08-15T10:00:00.000Z",
      }),
    );

    await h.useCase.execute(APPROVE_INPUT);

    expect(h.quoteRepository.all[0].status).toBe("APPROVED");
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("an outbox append failure ROLLS BACK the quote approval — no approval leaks", async () => {
    const outbox = new FailingAppendOutbox();
    const h = seededQuoteHarness(outbox);

    await expect(() => h.useCase.execute(APPROVE_INPUT)).rejectsWithCode(
      "INTERNAL_ERROR",
    );

    // All-or-nothing: the quote is still pending, nothing half-approved.
    expect(h.quoteRepository.all[0].status).toBe("PENDING_APPROVAL");
    expect(outbox.rows).toHaveLength(0);
  });
});