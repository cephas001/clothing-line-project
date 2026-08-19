// apps/api/tests/fakes/InMemoryCustomerRepository.ts
//
// In-memory ICustomerRepository keyed by customer id. The swap-variance flow
// resolves the customer email (for a Paystack upcharge) from this store.

import { Customer } from "@api/domain/entities/Customer";
import type { CustomerAuthenticationMetadata } from "@api/domain/shared/contracts";
import type { ICustomerRepository } from "@api/domain/interfaces/repositories/ICustomerRepository";
import type { Snapshotable } from "./cloneEntity";
import { cloneValue } from "./cloneEntity";

export class InMemoryCustomerRepository
  implements ICustomerRepository, Snapshotable
{
  private readonly customers = new Map<string, Customer>();

  seed(customer: Customer): void {
    this.customers.set(customer.id, customer);
  }

  get all(): Customer[] {
    return [...this.customers.values()];
  }

  async findById(customerId: string): Promise<Customer | null> {
    return this.customers.get(customerId) ?? null;
  }

  async findByEmail(email: string): Promise<Customer | null> {
    for (const customer of this.customers.values()) {
      if (customer.email === email) {
        return customer;
      }
    }
    return null;
  }

  async save(customer: Customer): Promise<void> {
    this.customers.set(customer.id, customer);
  }

  async updateAuthenticationMetadata(
    _customerId: string,
    _updates: CustomerAuthenticationMetadata,
  ): Promise<void> {}

  snapshot(): unknown {
    return cloneValue([...this.customers.values()]);
  }

  restore(state: unknown): void {
    this.customers.clear();
    for (const customer of state as Customer[]) {
      this.customers.set(customer.id, customer);
    }
  }
}