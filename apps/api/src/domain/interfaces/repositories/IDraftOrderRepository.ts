import { DraftOrderRecord } from "@api/domain/shared/contracts";

export interface IDraftOrderRepository {
  save(draftOrder: DraftOrderRecord): Promise<void>;
  findById(draftOrderId: string): Promise<DraftOrderRecord | null>;
}
