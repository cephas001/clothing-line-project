import { PromotionDiscountType } from "@api/domain/entities/Promotion";
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

export interface ShippingQuote extends JsonObject {
  id?: string;
  serviceLevel?: string;
  amountMinor?: number;
  currency?: string;
  etaDays?: number;
}

/**
 * Immutable financial snapshot of the promotion that was applied to an order at
 * checkout time. Persisted on the order so its financial history does not depend
 * on the mutable `promotion` table state after the order is created.
 */
export interface PromotionSnapshot {
  promotionId: string;
  code: string;
  discountType: PromotionDiscountType;
  discountValueMinor: number;
  minimumSpendMinor: number;
  appliedDiscountMinor: number;
}

/**
 * Persistence snapshot of a Promotion applied to a CART. Unlike the order
 * snapshot, this is intentionally NOT a frozen financial record — the cart must
 * be able to deliberately re-resolve/revalidate its promotion against the
 * current `promotion` table, so the full config is stored so a real Promotion
 * domain entity can be reconstructed on hydration.
 */
export interface CartPromotionSnapshot {
  id: string;
  code: string;
  discountType: PromotionDiscountType;
  discountValueMinor: number;
  minimumSpendMinor: number;
  isActive: boolean;
}
