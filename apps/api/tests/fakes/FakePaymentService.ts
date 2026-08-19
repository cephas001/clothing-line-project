// apps/api/tests/fakes/FakePaymentService.ts
//
// In-memory IPaymentService that RECORDS every obligation it is asked to
// initialize and every refund it is asked to issue. This is the assertion
// point for the "no client-provided financial values" invariant: the gateway
// must receive EXACTLY the server-authoritative values from the durable
// obligation — the adapter never recalculates an amount, currency, or
// reference. It is also the assertion point for refund dispatch: the gateway
// is never re-contacted for an already-issued refund.
//
// The fake can be configured to fail initialization/refund independently so
// tests can assert fail-closed behavior:
//   - a checkout/swap initialization failure leaves the obligation
//     initialization_pending;
//   - a refund failure leaves the refund 'pending' (ambiguous outcome), so a
//     retry surfaces REFUND_REQUIRES_REVIEW instead of double-refunding.

import type { JsonObject } from "@api/domain/shared/json";
import type {
  CheckoutPaymentObligation,
  IPaymentService,
  SwapPaymentObligation,
} from "@api/domain/interfaces/services/IPaymentService";

export interface RecordedRefund {
  transactionReference: string;
  amountMinor: number;
  payload: Record<string, unknown>;
}

export class FakePaymentService implements IPaymentService {
  /** Every checkout obligation the gateway was asked to accept, in order. */
  readonly checkoutInitializations: CheckoutPaymentObligation[] = [];
  /** Every swap-upcharge obligation the gateway was asked to accept, in order. */
  readonly swapInitializations: SwapPaymentObligation[] = [];
  /** Every refund the gateway was asked to issue, in order. */
  readonly refundsIssued: RecordedRefund[] = [];

  /** Optional override for the returned authorization URL. */
  authorizationUrl?: string;
  /** When set, initializeCheckoutTransaction throws this error. */
  failWith?: Error;
  /** When set, initializeSwapPayment throws this error. */
  failSwapWith?: Error;
  /** When set, issueRefund throws this error. */
  failRefundWith?: Error;
  /** Optional override for the returned provider refund reference. */
  providerRefundReference?: string | null;

  async initializeCheckoutTransaction(
    obligation: CheckoutPaymentObligation,
  ): Promise<{ authorizationUrl: string; providerReference: string | null }> {
    this.checkoutInitializations.push(obligation);
    if (this.failWith) {
      throw this.failWith;
    }
    return {
      authorizationUrl:
        this.authorizationUrl ??
        `https://pay.example/authorize/${obligation.reference}`,
      providerReference: `pay-${obligation.reference}`,
    };
  }

  async cancelInitialization(_payload: Record<string, unknown>): Promise<void> {}

  async initializeSwapPayment(
    obligation: SwapPaymentObligation,
  ): Promise<{ authorizationUrl: string; providerReference: string | null }> {
    this.swapInitializations.push(obligation);
    if (this.failSwapWith) {
      throw this.failSwapWith;
    }
    return {
      authorizationUrl:
        this.authorizationUrl ??
        `https://pay.example/swap/${obligation.reference}`,
      providerReference: `pay-${obligation.reference}`,
    };
  }

  async issueRefund(
    transactionReference: string,
    amountMinor: number,
    payload: Record<string, unknown>,
  ): Promise<{ providerRefundReference: string | null }> {
    this.refundsIssued.push({ transactionReference, amountMinor, payload });
    if (this.failRefundWith) {
      throw this.failRefundWith;
    }
    return {
      providerRefundReference:
        this.providerRefundReference ??
        `refund-${transactionReference}-${amountMinor}`,
    };
  }

  async cancelTransaction(_transactionReference: string): Promise<void> {}

  /** Metadata recorded on the most recent checkout obligation, if any. */
  lastMetadata(): JsonObject | null {
    const last = this.checkoutInitializations.at(-1);
    return last?.metadata ?? null;
  }
}