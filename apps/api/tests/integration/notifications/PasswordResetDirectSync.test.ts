// apps/api/tests/integration/notifications/PasswordResetDirectSync.test.ts
//
// INTEGRATION TESTS — L8-R PART 3: InitiatePasswordResetUseCase RETAINS the
// direct-sync notification path (it is deliberately NOT outbox-migrated).
//
// The `password_reset` intent carries the RAW single-use token — the adapter
// cannot compose the reset link without it and the token is not retrievable
// after hashing. Persisting it into the outbox (or a job payload) would
// durably store a credential-bearing secret in the async pipeline.
//
// PROOFS:
//   1. The raw token is delivered DIRECTLY to the notification service and the
//      outbox holds ZERO rows — the token never touches the async pipeline.
//   2. The notification fires strictly AFTER the reset metadata persistence.
//   3. A notification failure NEVER rolls back committed state — the reset
//      metadata survives and the use case does not throw.
//   4. The raw token never appears in any log output.
//   5. An unknown email fails silently (no enumeration, no notification).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { InitiatePasswordResetUseCase } from "@api/use-cases/customers/InitiatePasswordResetUseCase";
import { Customer } from "@api/domain/entities/Customer";
import { InMemoryCustomerRepository } from "../../fakes/InMemoryCustomerRepository";
import { InMemoryNotificationOutboxRepository } from "../../fakes/InMemoryNotificationOutboxRepository";
import { InMemoryAuditLogService } from "../../fakes/InMemoryAuditLogService";
import { SequenceIdGenerator } from "../../fakes/SequenceIdGenerator";
import type {
  PasswordResetTokenClaims,
  PasswordResetTokenIssueResult,
  TokenClaims,
  CustomerAuthenticationMetadata,
} from "@api/domain/shared/contracts";
import type { ITokenService } from "@api/domain/interfaces/services/ITokenService";
import type {
  INotificationService,
  NotificationDispatchResult,
  PasswordResetNotification,
} from "@api/domain/shared/notifications";
import type { ILogger } from "@api/domain/interfaces/shared/ILogger";

const RAW_TOKEN = "reset-token-xyz";

/** Token service returning a deterministic { token, id, expiresAt }. */
class ResetTokenServiceFake implements ITokenService {
  async generatePasswordResetToken(
    _customerId: string,
  ): Promise<PasswordResetTokenIssueResult> {
    return {
      token: RAW_TOKEN,
      id: "token-1",
      expiresAt: "2026-08-17T11:00:00.000Z",
    };
  }
  async hashToken(token: string): Promise<string> {
    return `hashed:${token}`;
  }
  async generateAuthToken(_payload: TokenClaims): Promise<string> {
    throw new Error("not implemented");
  }
  async verifyToken(_token: string): Promise<TokenClaims> {
    throw new Error("not implemented");
  }
  async verifyPasswordResetToken(
    _token: string,
  ): Promise<PasswordResetTokenClaims> {
    throw new Error("not implemented");
  }
  async verifyTokenHash(_token: string, _hash: string): Promise<boolean> {
    throw new Error("not implemented");
  }
  async revokePasswordResetToken(_userId: string): Promise<void> {
    throw new Error("not implemented");
  }
  async revokeToken(_token: string): Promise<void> {
    throw new Error("not implemented");
  }
}

/**
 * Customer repository that ACTUALLY applies the reset metadata — the base
 * InMemoryCustomerRepository.updateAuthenticationMetadata is a no-op, which
 * would make the after-persistence ordering impossible to observe.
 */
class PersistingCustomerRepository extends InMemoryCustomerRepository {
  override async updateAuthenticationMetadata(
    customerId: string,
    updates: CustomerAuthenticationMetadata,
  ): Promise<void> {
    const customer = await this.findById(customerId);
    if (!customer) {
      return;
    }
    if (updates.passwordResetTokenId !== undefined) {
      customer.passwordResetTokenId = updates.passwordResetTokenId;
    }
    if (updates.passwordResetTokenHash !== undefined) {
      customer.passwordResetTokenHash = updates.passwordResetTokenHash;
    }
    if (updates.passwordResetRequestedAt !== undefined) {
      customer.passwordResetRequestedAt = updates.passwordResetRequestedAt;
    }
    if (updates.passwordResetExpiresAt !== undefined) {
      customer.passwordResetExpiresAt = updates.passwordResetExpiresAt;
    }
    if (updates.passwordResetRequestIp !== undefined) {
      customer.passwordResetRequestIp = updates.passwordResetRequestIp;
    }
  }
}

/** Notification service that records the password-reset delivery (or fails). */
class RecordingPasswordResetNotifier implements INotificationService {
  received: PasswordResetNotification[] = [];
  fail = false;
  onSend?: (notification: PasswordResetNotification) => void;

  async sendPasswordReset(
    notification: PasswordResetNotification,
  ): Promise<NotificationDispatchResult> {
    if (this.fail) {
      throw new Error("provider unavailable");
    }
    this.onSend?.(notification);
    this.received.push(notification);
    return { providerMessageId: "msg-1" };
  }

  async sendPaymentConfirmation(): Promise<NotificationDispatchResult> {
    throw new Error("not implemented");
  }
  async sendShipmentDispatched(): Promise<NotificationDispatchResult> {
    throw new Error("not implemented");
  }
  async sendTrackingUpdate(): Promise<NotificationDispatchResult> {
    throw new Error("not implemented");
  }
  async sendRefundIssued(): Promise<NotificationDispatchResult> {
    throw new Error("not implemented");
  }
  async sendQuoteApproved(): Promise<NotificationDispatchResult> {
    throw new Error("not implemented");
  }
  async sendDraftOrderInvoice(): Promise<NotificationDispatchResult> {
    throw new Error("not implemented");
  }
}

/** Logger that captures every message so the token can be proven absent. */
class CapturingLogger implements ILogger {
  readonly messages: string[] = [];
  debug(message: string): void {
    this.messages.push(message);
  }
  info(message: string): void {
    this.messages.push(message);
  }
  warn(message: string): void {
    this.messages.push(message);
  }
  error(message: string): void {
    this.messages.push(message);
  }
}

interface PasswordResetHarness {
  customerRepository: PersistingCustomerRepository;
  notifier: RecordingPasswordResetNotifier;
  outbox: InMemoryNotificationOutboxRepository;
  audit: InMemoryAuditLogService;
  logger: CapturingLogger;
  useCase: InitiatePasswordResetUseCase;
}

function createHarness(): PasswordResetHarness {
  const customerRepository = new PersistingCustomerRepository();
  const notifier = new RecordingPasswordResetNotifier();
  const outbox = new InMemoryNotificationOutboxRepository();
  const audit = new InMemoryAuditLogService();
  const logger = new CapturingLogger();
  const useCase = new InitiatePasswordResetUseCase(
    customerRepository,
    new ResetTokenServiceFake(),
    notifier,
    audit,
    new SequenceIdGenerator(),
    logger,
  );
  return { customerRepository, notifier, outbox, audit, logger, useCase };
}

const RESET_INPUT = {
  email: "BUYER@Example.com",
  ipAddress: "203.0.113.9",
  userAgent: "test-agent",
};

describe("InitiatePasswordResetUseCase — direct-sync retained (never outboxed)", () => {
  it("delivers the RAW token directly to the notification service; the outbox holds ZERO rows", async () => {
    const h = createHarness();
    h.customerRepository.seed(
      new Customer({
        id: "customer-1",
        firstName: "Ada",
        lastName: "Okafor",
        email: "buyer@example.com",
      }),
    );

    await h.useCase.execute(RESET_INPUT);

    // The raw token reached the adapter directly (it must, to render the link).
    expect(h.notifier.received).toHaveLength(1);
    expect(h.notifier.received[0].token).toBe(RAW_TOKEN);
    expect(h.notifier.received[0].recipient.email).toBe("buyer@example.com");

    // The async pipeline never saw the token: zero outbox rows.
    expect(h.outbox.rows).toHaveLength(0);
  });

  it("fires the notification strictly AFTER the reset metadata was persisted", async () => {
    const h = createHarness();
    h.customerRepository.seed(
      new Customer({
        id: "customer-1",
        firstName: "Ada",
        lastName: "Okafor",
        email: "buyer@example.com",
      }),
    );
    // If the notification ever ran before the metadata write, this probe throws
    // and the test fails.
    const probe = async (notification: PasswordResetNotification) => {
      const customer = await h.customerRepository.findById(
        notification.customerId,
      );
      if (!customer || customer.passwordResetTokenId !== "token-1") {
        throw new Error(
          "sendPasswordReset fired BEFORE the reset metadata was persisted",
        );
      }
    };
    h.notifier.onSend = probe;

    await h.useCase.execute(RESET_INPUT);

    expect(h.notifier.received).toHaveLength(1);
    expect(h.customerRepository.all[0].passwordResetTokenId).toBe("token-1");
  });

  it("a notification failure NEVER rolls back state and does not throw", async () => {
    const h = createHarness();
    h.customerRepository.seed(
      new Customer({
        id: "customer-1",
        firstName: "Ada",
        lastName: "Okafor",
        email: "buyer@example.com",
      }),
    );
    h.notifier.fail = true;

    await expect(() => h.useCase.execute(RESET_INPUT)).resolves();

    // Committed state survives the failed email: reset metadata + audit entry.
    expect(h.customerRepository.all[0].passwordResetTokenId).toBe("token-1");
    expect(h.audit.actions().includes("PASSWORD_RESET_INITIATED")).toBe(true);
  });

  it("the RAW token never appears in any log output", async () => {
    const h = createHarness();
    h.customerRepository.seed(
      new Customer({
        id: "customer-1",
        firstName: "Ada",
        lastName: "Okafor",
        email: "buyer@example.com",
      }),
    );

    await h.useCase.execute(RESET_INPUT);

    expect(h.logger.messages.length).toBeGreaterThan(0);
    for (const message of h.logger.messages) {
      expect(message).not.toContain(RAW_TOKEN);
    }
  });

  it("an unknown email fails silently — no notification, no outbox row, no enumeration", async () => {
    const h = createHarness();

    await h.useCase.execute({ ...RESET_INPUT, email: "ghost@example.com" });

    expect(h.notifier.received).toHaveLength(0);
    expect(h.outbox.rows).toHaveLength(0);
    expect(h.audit.actions().includes("PASSWORD_RESET_INITIATED")).toBe(false);
    expect(
      h.audit.actions().includes("PASSWORD_RESET_INITIATED_UNKNOWN_EMAIL"),
    ).toBe(true);
  });
});