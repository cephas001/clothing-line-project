import { Order } from "@api/domain/entities/Order";

export interface IOrderReadRepository {
  findHistoryByCustomerId(
    customerId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: Order[]; total: number }>;
}
