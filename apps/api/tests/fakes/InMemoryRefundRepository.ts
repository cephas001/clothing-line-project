// apps/api/tests/fakes/InMemoryRefundRepository.ts
//
// In-memory IRefundRepository that FAITHFULLY mirrors the database refund
// guards:
//
//   - UNIQUE(refund_reference)                          — app idempotency key.
//   - UNIQUE(provider_transaction_reference, amount_minor) — the same refund
//     request can never be issued twice.
//
// `save()` inserts a new row and reconciles an EXISTING row (by id) in place
// (mirroring onConflict(id) update). A collision surfaces
// RepositoryErrorCode.DUPLICATE. `sumRefundedMinor` counts pending +
// dispatched refunds (never `failed`), authoritative within the current unit
// of work — exactly what the swap refund guard depends on.

import { Refund } from "@api/domain/entities/Refund";
import type { IRefundRepository } from "@api/domain/interfaces/repositories/IRefundRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryRefundRepository implements IRefundRepository, Snapshotable {
  private readonly refunds = new Map<string, Refund>();

  seed(refund: Refund): void {
    this.refunds.set(refund.id, refund);
  }

  get all(): Refund[] {
    return [...this.refunds.values()];
  }

  async findById(refundId: string): Promise<Refund | null> {
    return this.refunds.get(refundId) ?? null;
  }

  async findByRefundReference(refundReference: string): Promise<Refund | null> {
    for (const refund of this.refunds.values()) {
      if (refund.refundReference === refundReference) {
        return refund;
      }
    }
    return null;
  }

  async findByTransactionAndAmount(
    providerTransactionReference: string,
    amountMinor: number,
  ): Promise<Refund | null> {
    for (const refund of this.refunds.values()) {
      if (
        refund.providerTransactionReference === providerTransactionReference &&
        refund.amountMinor === amountMinor
      ) {
        return refund;
      }
    }
    return null;
  }

  async sumRefundedMinor(providerTransactionReference: string): Promise<number> {
    let sum = 0;
    for (const refund of this.refunds.values()) {
      if (
        refund.providerTransactionReference === providerTransactionReference &&
        refund.status !== "failed"
      ) {
        sum += refund.amountMinor;
      }
    }
    return sum;
  }

  async save(refund: Refund): Promise<void> {
    const existing = this.refunds.get(refund.id);
    if (existing) {
      // Reconcile in place (mirrors onConflict(id) doUpdateSet).
      this.refunds.set(refund.id, refund);
      return;
    }

    const duplicateReference = [...this.refunds.values()].some(
      (r) => r.refundReference === refund.refundReference,
    );
    if (duplicateReference) {
      throw this.duplicate(
        `UNIQUE(refund_reference) violated for ${refund.refundReference}.`,
      );
    }

    const duplicatePair = [...this.refunds.values()].some(
      (r) =>
        r.providerTransactionReference === refund.providerTransactionReference &&
        r.amountMinor === refund.amountMinor,
    );
    if (duplicatePair) {
      throw this.duplicate(
        `UNIQUE(provider_transaction_reference, amount_minor) violated for ${refund.providerTransactionReference}/${refund.amountMinor}.`,
      );
    }

    this.refunds.set(refund.id, refund);
  }

  snapshot(): unknown {
    return cloneValue([...this.refunds.values()]);
  }

  restore(state: unknown): void {
    this.refunds.clear();
    for (const refund of state as Refund[]) {
      this.refunds.set(refund.id, refund);
    }
  }

  private duplicate(message: string): RepositoryError {
    const error = new Error(message) as RepositoryError;
    error.name = "RepositoryError";
    error.code = RepositoryErrorCode.DUPLICATE;
    return error;
  }
}