// apps/api/tests/fakes/FakeLogisticsService.ts
import type { Cart } from "@api/domain/entities/Cart";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import type { ILogisticsService } from "@api/domain/interfaces/services/ILogisticsService";
import type {
  ProviderShipmentReference,
  ReturnLabelRequest,
  ReturnLabelResult,
  ShippingLabelRequest,
  ShippingLabelResult,
  ShippingQuote,
} from "@api/domain/shared/contracts";

/**
 * In-memory logistics provider for the L6 logistics test suites.
 *
 * Records every provider interaction so tests can assert on the EXACT
 * request the application shipped across the boundary (one shipment per
 * dispatch, verbatim snapshot, never a blind retry). Failure injection
 * builds `RepositoryError`s whose `meta` mirrors the concrete adapter so the
 * use case's ambiguity classification (`meta.ambiguous`, `meta.providerShipmentId`)
 * is exercised for real.
 */
export class FakeLogisticsService implements ILogisticsService {
  readonly rateCalls: Cart[] = [];
  readonly labelRequests: ShippingLabelRequest[] = [];
  readonly cancellations: Array<{ orderId: string; reference: ProviderShipmentReference }> = [];

  /** Rates returned by the next {@link fetchDynamicRates} call. */
  rates?: ShippingQuote[];
  /** Failure raised by the next {@link fetchDynamicRates} call. */
  failRatesWith?: Error;

  /** Result returned by the next {@link createShippingLabel} call. */
  labelResult?: ShippingLabelResult;
  /** Unclassified failure raised by the next {@link createShippingLabel} call. */
  failCreateWith?: Error;
  /** Classified failure code raised by the next {@link createShippingLabel} call. */
  failCreateWithCode?: RepositoryErrorCode;
  /** When set, marks the injected failure as `ambiguous` (unknown/timed-out outcome). */
  failCreateAmbiguous?: boolean;
  /** When set, carries a providerShipmentId in the injected failure `meta`. */
  createProviderShipmentId?: string | null;

  async fetchDynamicRates(cart: Cart): Promise<ShippingQuote[]> {
    this.rateCalls.push(cart);
    if (this.failRatesWith) throw this.failRatesWith;
    return this.rates ?? [];
  }

  async createShippingLabel(request: ShippingLabelRequest): Promise<ShippingLabelResult> {
    this.labelRequests.push(request);
    if (this.failCreateWith) throw this.failCreateWith;
    if (this.failCreateWithCode) {
      throw this.serviceError(
        this.failCreateWithCode,
        this.failCreateAmbiguous,
        this.createProviderShipmentId,
      );
    }
    return (
      this.labelResult ?? {
        providerShipmentId: "SB-ORDER-1",
        trackingNumber: "TRK-ORDER-1",
        labelUrl: null,
        courier: "DHL",
        serviceLevel: request.selection.serviceLevel ?? null,
      }
    );
  }

  async cancelFulfillment(orderId: string, reference: ProviderShipmentReference): Promise<void> {
    this.cancellations.push({ orderId, reference });
  }

  async createReturnLabel(_request: ReturnLabelRequest): Promise<ReturnLabelResult> {
    return { providerShipmentId: "SB-RETURN-1", url: null };
  }

  async cancelReturnLabel(
    _orderId: string,
    _reference: ProviderShipmentReference,
  ): Promise<void> {}

  private serviceError(
    code: RepositoryErrorCode,
    ambiguous: boolean | undefined,
    providerShipmentId: string | null | undefined,
  ): RepositoryError {
    const error = new Error(`Injected logistics failure (${code}).`) as RepositoryError;
    error.name = "ShipbubbleLogisticsError";
    error.code = code;
    error.meta = {
      ...(ambiguous ? { ambiguous: true } : {}),
      ...(providerShipmentId ? { providerShipmentId } : {}),
    };
    return error;
  }
}