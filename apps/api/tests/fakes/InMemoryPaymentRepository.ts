// apps/api/tests/fakes/InMemoryPaymentRepository.ts
//
// In-memory IPaymentRepository that FAITHFULLY mirrors the database guards
// established by migrations 0004 + 0010:
//
//   - UNIQUE(reference)                         — one app idempotency key.
//   - UNIQUE(provider_reference)                — one provider transaction.
//   - partial UNIQUE(obligation_type, obligation_id)
//       WHERE status <> 'failed'                — one ACTIVE obligation per
//                                                  business object; a fresh row
//                                                  is allowed only after the
//                                                  prior obligation was reset
//                                                  to `failed`.
//
// `save()` inserts a new row and reconciles an EXISTING row (by id) in place,
// matching PostgresPaymentRepository's onConflict(id) update. A collision
// surfaces RepositoryErrorCode.DUPLICATE — exactly what the use cases map into
// idempotent replay instead of a double charge.

import { Payment, PaymentObligationType } from "@api/domain/entities/Payment";
import type { IPaymentRepository } from "@api/domain/interfaces/repositories/IPaymentRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryPaymentRepository implements IPaymentRepository, Snapshotable {
  private readonly payments = new Map<string, Payment>();
  /** Insert order (mirrors Postgres `order by created_at desc`). */
  private readonly insertionOrder: string[] = [];

  /** Test-only: when set, the next save() throws a RepositoryError with this code. */
  failNextSaveWith?: RepositoryErrorCode;

  seed(payment: Payment): void {
    this.payments.set(payment.id, payment);
    if (!this.insertionOrder.includes(payment.id)) {
      this.insertionOrder.push(payment.id);
    }
  }

  get all(): Payment[] {
    return [...this.payments.values()];
  }

  isEmpty(): boolean {
    return this.payments.size === 0;
  }

  async findById(paymentId: string): Promise<Payment | null> {
    return this.payments.get(paymentId) ?? null;
  }

  async findByReference(reference: string): Promise<Payment | null> {
    for (const payment of this.payments.values()) {
      if (payment.reference === reference) {
        return payment;
      }
    }
    return null;
  }

  async findByProviderReference(
    providerReference: string,
  ): Promise<Payment | null> {
    for (const payment of this.payments.values()) {
      if (payment.providerReference === providerReference) {
        return payment;
      }
    }
    return null;
  }

  async findByObligation(
    obligationType: PaymentObligationType,
    obligationId: string,
  ): Promise<Payment | null> {
    // Most recently inserted row for the obligation (created_at desc).
    for (let i = this.insertionOrder.length - 1; i >= 0; i -= 1) {
      const payment = this.payments.get(this.insertionOrder[i]);
      if (
        payment &&
        payment.obligationType === obligationType &&
        payment.obligationId === obligationId
      ) {
        return payment;
      }
    }
    return null;
  }

  async countFailedByObligation(
    obligationType: PaymentObligationType,
    obligationId: string,
  ): Promise<number> {
    let count = 0;
    for (const payment of this.payments.values()) {
      if (
        payment.obligationType === obligationType &&
        payment.obligationId === obligationId &&
        payment.status === "failed"
      ) {
        count += 1;
      }
    }
    return count;
  }

  async lockPaymentForUpdate(reference: string): Promise<Payment | null> {
    return this.findByReference(reference);
  }

  async save(payment: Payment): Promise<void> {
    if (this.failNextSaveWith) {
      const code = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw this.repositoryError(code, "Injected repository failure.");
    }
    const existing = this.payments.get(payment.id);
    if (existing) {
      // Reconcile in place (mirrors onConflict(id) doUpdateSet).
      this.payments.set(payment.id, payment);
      return;
    }

    const duplicateReference = [...this.payments.values()].some(
      (p) => p.reference === payment.reference,
    );
    if (duplicateReference) {
      throw this.duplicate(
        `UNIQUE(reference) violated for ${payment.reference}.`,
      );
    }

    if (payment.providerReference) {
      const duplicateProvider = [...this.payments.values()].some(
        (p) => p.providerReference === payment.providerReference,
      );
      if (duplicateProvider) {
        throw this.duplicate(
          `UNIQUE(provider_reference) violated for ${payment.providerReference}.`,
        );
      }
    }

    const activeObligation = [...this.payments.values()].some(
      (p) =>
        p.obligationType === payment.obligationType &&
        p.obligationId === payment.obligationId &&
        p.status !== "failed",
    );
    if (activeObligation) {
      throw this.duplicate(
        `Active obligation already exists for ${payment.obligationType}:${payment.obligationId}.`,
      );
    }

    this.payments.set(payment.id, payment);
    this.insertionOrder.push(payment.id);
  }

  private duplicate(message: string): RepositoryError {
    return this.repositoryError(RepositoryErrorCode.DUPLICATE, message);
  }

  private repositoryError(
    code: RepositoryErrorCode,
    message: string,
  ): RepositoryError {
    const error = new Error(message) as RepositoryError;
    error.name = "RepositoryError";
    error.code = code;
    return error;
  }

  snapshot(): unknown {
    return {
      payments: cloneValue([...this.payments.values()]),
      insertionOrder: cloneValue(this.insertionOrder),
    };
  }

  restore(state: unknown): void {
    const snapshot = state as {
      payments: Payment[];
      insertionOrder: string[];
    };
    this.payments.clear();
    for (const payment of snapshot.payments) {
      this.payments.set(payment.id, payment);
    }
    this.insertionOrder.length = 0;
    this.insertionOrder.push(...snapshot.insertionOrder);
  }
}