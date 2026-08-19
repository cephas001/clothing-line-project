import { Cart } from "@api/domain/entities/Cart";
import {
  ProviderShipmentReference,
  ReturnLabelRequest,
  ReturnLabelResult,
  ShippingLabelRequest,
  ShippingLabelResult,
  ShippingQuote,
} from "@api/domain/shared/contracts";

/**
 * Logistics provider contract.
 *
 * The application supplies everything the provider needs to create a shipment
 * (receiver info, parcel items, weights, dimensions, the APPLICATION-selected
 * courier + service level, and the provider `request_token` from the rate
 * response). The adapter NEVER independently chooses a courier, invents a
 * price, or fabricates a label/tracking number. Cancellation and return
 * operations reference shipments by the PROVIDER shipment id (never the
 * application orderId).
 */
export interface ILogisticsService {
  fetchDynamicRates(cart: Cart): Promise<ShippingQuote[]>;

  /**
   * Create a shipment from the application's frozen shipping snapshot. The
   * request carries the selected quote (courier + service + amount) and the
   * provider request_token obtained by {@link fetchDynamicRates}, so the
   * provider is never asked to choose anything.
   */
  createShippingLabel(request: ShippingLabelRequest): Promise<ShippingLabelResult>;

  /**
   * Cancel an existing shipment identified by its provider shipment id
   * (e.g. "SB-..."). The tracking number is supplied when available for
   * diagnostics only — the provider is addressed by providerShipmentId.
   */
  cancelFulfillment(
    orderId: string,
    reference: ProviderShipmentReference,
  ): Promise<void>;

  /**
   * Create a return (reverse) shipping label originating from the original
   * outbound shipment's provider id.
   */
  createReturnLabel(request: ReturnLabelRequest): Promise<ReturnLabelResult>;

  /**
   * Cancel a previously created return label by its provider shipment id.
   */
  cancelReturnLabel(
    orderId: string,
    reference: ProviderShipmentReference,
  ): Promise<void>;
}
