import { FulfillmentRecord } from "@api/domain/shared/contracts";

export interface IFulfillmentRepository {
  save(fulfillment: FulfillmentRecord): Promise<void>;
  findByTrackingNumber(
    trackingNumber: string,
  ): Promise<FulfillmentRecord | null>;
}
