export interface INotificationService {
  notifyQuoteApproved(
    quoteId: string,
    customerId: string,
    payload: {
      approvedBy: string;
      approvedTotalMinor: number;
      approvedAt: string;
      note?: string | null;
    },
  ): Promise<void>;
  sendPasswordResetEmail(
    email: string,
    token: string,
    payload: {
      expiresInSeconds: number;
      ipAddress: string;
      userAgent: string;
    },
  ): Promise<void>;
  sendTrackingUpdate(
    orderId: string,
    status: string,
    payload: {
      trackingNumber: string;
      courier?: string | null;
      occurredAt: string;
    },
  ): Promise<void>;
  sendDraftOrderInvoice(email: string, draftOrderId: string): Promise<void>;
}
