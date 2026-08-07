import { Order } from "@api/domain/entities/Order";

export interface IOrderRepository {
  findById(orderId: string): Promise<Order | null>;
  hasCustomerPurchasedProduct(
    customerId: string,
    productId: string,
  ): Promise<boolean>;
  save(order: Order): Promise<void>;
  findByTransactionReference(reference: string): Promise<Order | null>;
}
