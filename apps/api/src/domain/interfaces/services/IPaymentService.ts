export interface IPaymentService {
  initializeTransaction(payload: Record<string, unknown>): Promise<string>;
  cancelInitialization(payload: Record<string, unknown>): Promise<void>;
  initializeTransactionForAmount(
    customerId: string,
    amountMinor: number,
    payload: Record<string, unknown>,
  ): Promise<{
    reference: string;
    paymentUrl: string;
  }>;
  issueRefund(
    transactionReference: string,
    amountMinor: number,
    payload: Record<string, unknown>,
  ): Promise<void>;
  cancelTransaction(transactionReference: string): Promise<void>;
}
