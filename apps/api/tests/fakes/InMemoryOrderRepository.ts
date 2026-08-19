// apps/api/tests/fakes/InMemoryOrderRepository.ts

// In-memory IOrderRepository for finalization assertions (frozen financial
// snapshot, idempotent resolution by transaction reference). Faithfully
// mirrors the database guard `UNIQUE(order.transaction_reference)`: saving an
// order whose transaction reference is already taken by a DIFFERENT order
// surfaces RepositoryErrorCode.DUPLICATE — the intentional unique-conflict
// race FinalizeOrderTransactionUseCase resolves idempotently. Saving the SAME
// order id reconciles in place.

import { Order } from "@api/domain/entities/Order";
import type { IOrderRepository } from "@api/domain/interfaces/repositories/IOrderRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryOrderRepository implements IOrderRepository, Snapshotable {
  private readonly orders = new Map<string, Order>();

  /** Test-only: when set, the next save() throws a RepositoryError with this code. */
  failNextSaveWith?: RepositoryErrorCode;

  seed(order: Order): void {
    this.orders.set(order.id, order);
  }

  get all(): Order[] {
    return [...this.orders.values()];
  }

  async findById(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) ?? null;
  }

  async findByTransactionReference(reference: string): Promise<Order | null> {
    for (const order of this.orders.values()) {
      if (order.transactionReference === reference) {
        return order;
      }
    }
    return null;
  }

  async hasCustomerPurchasedProduct(
    _customerId: string,
    _productId: string,
  ): Promise<boolean> {
    return false;
  }

  async save(order: Order): Promise<void> {
    if (this.failNextSaveWith) {
      const code = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw this.repositoryError(code, "Injected repository failure.");
    }
    const existing = this.orders.get(order.id);
    if (existing) {
      // Reconcile in place (mirrors onConflict(id) doUpdateSet).
      this.orders.set(order.id, order);
      return;
    }

    if (order.transactionReference) {
      const duplicateReference = [...this.orders.values()].some(
        (o) =>
          o.id !== order.id &&
          o.transactionReference === order.transactionReference,
      );
      if (duplicateReference) {
        throw this.repositoryError(
          RepositoryErrorCode.DUPLICATE,
          `UNIQUE(order.transaction_reference) violated for ${order.transactionReference}.`,
        );
      }
    }

    this.orders.set(order.id, order);
  }

  snapshot(): unknown {
    return cloneValue([...this.orders.values()]);
  }

  restore(state: unknown): void {
    this.orders.clear();
    for (const order of state as Order[]) {
      this.orders.set(order.id, order);
    }
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
}