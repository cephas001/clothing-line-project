// apps/api/tests/fakes/InMemoryCartRepository.ts

// In-memory ICartRepository. Stores Cart aggregates by id (reference
// semantics), mirroring how the Postgres repository rehydrates the aggregate
// and hands it to the use case. Also implements Snapshotable + a fail-once
// hook so the rollback tests can prove a mid-transaction cart save leaves zero
// partial state.

import { Cart } from "@api/domain/entities/Cart";
import type { ICartRepository } from "@api/domain/interfaces/repositories/ICartRepository";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryCartRepository implements ICartRepository, Snapshotable {
  private readonly carts = new Map<string, Cart>();

  /** Test-only: when set, the next save() throws a RepositoryError with this code. */
  failNextSaveWith?: RepositoryErrorCode;

  seed(cart: Cart): void {
    this.carts.set(cart.id, cart);
  }

  get(cartId: string): Cart | null {
    return this.carts.get(cartId) ?? null;
  }

  async findById(cartId: string): Promise<Cart | null> {
    return this.carts.get(cartId) ?? null;
  }

  async save(cart: Cart): Promise<void> {
    if (this.failNextSaveWith) {
      const code = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw this.repositoryError(code, "Injected repository failure.");
    }
    this.carts.set(cart.id, cart);
  }

  async delete(cartId: string): Promise<void> {
    this.carts.delete(cartId);
  }

  async deleteAbandonedCarts(_expirationDateThreshold: Date): Promise<number> {
    return 0;
  }

  snapshot(): unknown {
    return cloneValue([...this.carts.values()]);
  }

  restore(state: unknown): void {
    this.carts.clear();
    for (const cart of state as Cart[]) {
      this.carts.set(cart.id, cart);
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