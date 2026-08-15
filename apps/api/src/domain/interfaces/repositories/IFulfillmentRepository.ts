import { FulfillmentRecord } from "@api/domain/shared/contracts";

export interface IFulfillmentRepository {
  save(fulfillment: FulfillmentRecord): Promise<void>;
  findByTrackingNumber(
    trackingNumber: string,
  ): Promise<FulfillmentRecord | null>;
  /**
   * Resolve the LOCAL fulfillment for a PROVIDER shipment id (e.g. "SB-...").
   * The provider id is the authoritative cross-boundary identity: the logistics
   * worker resolves fulfillment by it (NEVER by orderId, trackingNumber, or
   * cartId) so webhook events always attach to the correct durable record.
   */
  findByProviderShipmentId(
    providerShipmentId: string,
  ): Promise<FulfillmentRecord | null>;
}
