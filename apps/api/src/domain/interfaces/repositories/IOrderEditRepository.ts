import { OrderEdit } from "@api/domain/entities/OrderEdit";

export interface IOrderEditRepository {
  save(orderEdit: OrderEdit): Promise<void>;
  findById(orderEditId: string): Promise<OrderEdit | null>;
}
