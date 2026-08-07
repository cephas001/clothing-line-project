import { Customer } from "@api/domain/entities/Customer";
import { CustomerAuthenticationMetadata } from "@api/domain/shared/contracts";

export interface ICustomerRepository {
  findById(customerId: string): Promise<Customer | null>;
  save(customer: Customer): Promise<void>;
  findByEmail(email: string): Promise<Customer | null>;
  updateAuthenticationMetadata(
    customerId: string,
    updates: CustomerAuthenticationMetadata,
  ): Promise<void>;
}
