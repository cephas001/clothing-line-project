import { Cart } from "@api/domain/entities/Cart";
import { ShippingQuote } from "@api/domain/shared/contracts";

export interface ILogisticsService {
  fetchDynamicRates(cart: Cart): Promise<ShippingQuote[]>;
  cancelFulfillment(
    orderId: string,
    { trackingNumber }: { trackingNumber: string | number },
  ): Promise<void>;
  createShippingLabel(
    orderId: string,
    {
      preferredCourier,
      serviceLevel,
    }: {
      preferredCourier?: string | null;
      serviceLevel?: string | null;
    },
  ): Promise<{ labelUrl: string; trackingNumber: string }>;
  createReturnLabel(
    orderId: string,
    items: Array<{ lineItemId: string; quantity: number }>,
  ): Promise<{ url: string }>;
  cancelReturnLabel(orderId: string): Promise<void>;
}
