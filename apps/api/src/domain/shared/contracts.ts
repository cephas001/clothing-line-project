import { JsonObject, JsonValue } from "@api/domain/shared/json";

export { JsonObject, JsonValue };

export interface StructuredMeta extends JsonObject {}

export interface TokenClaims extends JsonObject {}

export interface PasswordResetTokenClaims extends JsonObject {
  customerId: string;
  id?: string;
  expiresAt?: string;
}

export interface PasswordResetTokenIssueResult {
  token: string;
  id: string;
  expiresAt: string;
}

export interface CustomerAuthenticationMetadata {
  failedAttempts?: number;
  lastFailedAt?: string | null;
  lockUntil?: string | null;
  lastLoginAt?: string | null;
  passwordHash?: string;
  passwordUpdatedAt?: string;
  passwordResetTokenId?: string | null;
  passwordResetTokenHash?: string | null;
  passwordResetRequestedAt?: string | null;
  passwordResetExpiresAt?: string | null;
  securityStamp?: string;
  passwordResetRequestIp?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  addresses?: JsonObject[];
  metadata?: JsonObject;
}

export interface AddressBookEntry extends JsonObject {
  id: string;
}

export interface ProductReadQuery {
  salesChannelId?: string;
  regionId?: string;
  q?: string;
  limit?: number;
  offset?: number;
  expand?: string[];
  fields?: string[];
  [key: string]: JsonValue | undefined;
}

export interface TransactionClient {
  [key: string]: unknown;
}

export interface DatabaseTerminationResult {
  terminatedCount: number;
}

export interface DraftOrderItem {
  title: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface DraftOrderRecord {
  id: string;
  email: string;
  items: DraftOrderItem[];
  shippingAddress: JsonObject | null;
  totalMinor: number;
  status: "awaiting_payment";
  createdBy: string;
  createdAt: string;
  metadata: {
    createdByActor: string;
  };
}

export interface BusinessUnitMemberRecord {
  customerId: string;
  role: string;
}

export interface BusinessUnitRecord {
  id: string;
  name: string;
  registrationNumber: string;
  salesChannelId: string;
  members: BusinessUnitMemberRecord[];
  createdAt: string;
}

export interface FulfillmentRecord extends JsonObject {
  id: string;
  orderId: string;
  trackingNumber: string;
}

export interface ReturnAuthorizationRecord extends JsonObject {
  id: string;
  orderId: string;
  items: Array<{
    lineItemId: string;
    quantity: number;
    reasonCode: string;
  }>;
  refundAmountMinor: number;
  shippingLabelUrl: string | null;
  status: string;
  requestedByCustomerId: string | null;
  createdBy: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface SwapRecord extends JsonObject {
  id: string;
  orderId: string;
  returnLineItemId: string;
  returnQuantity: number;
  newVariantId: string;
  newVariantPriceMinor: number;
  originalValueMinor: number;
  differenceMinor: number;
  status: string;
  createdAt: string;
  createdBy: string;
  paymentReference?: string | null;
  paymentUrl?: string | null;
}

export interface ShippingQuote extends JsonObject {
  id?: string;
  serviceLevel?: string;
  amountMinor?: number;
  currency?: string;
  etaDays?: number;
}
