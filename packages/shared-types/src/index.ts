// packages/shared-types/src/index.ts
import { components, paths } from "./api-types";

// 1. Export the base generated objects
export type { components, paths };

// ============================================================================
// 2. GLOBAL REUSABLE SCHEMAS (DOMAIN DTOs)
// ============================================================================
export type StandardError = components["schemas"]["StandardError"];

// Catalog
export type Product = components["schemas"]["Product"];
export type ProductVariant = components["schemas"]["ProductVariant"];
export type ProductList = components["schemas"]["ProductList"];
export type VariantAvailability = components["schemas"]["VariantAvailability"];
export type Category = components["schemas"]["Category"];
export type Collection = components["schemas"]["Collection"];

// Cart
export type Cart = components["schemas"]["Cart"];
export type CartLineItem = components["schemas"]["CartLineItem"];
export type AppliedPromotion = components["schemas"]["AppliedPromotion"];

// Checkout
export type ShippingAddress = components["schemas"]["ShippingAddress"];
export type ShippingQuote = components["schemas"]["ShippingQuote"];
export type InsuranceQuoteResponse =
  components["schemas"]["InsuranceQuoteResponse"];
export type PaymentSessionResponse =
  components["schemas"]["PaymentSessionResponse"];

// Order & Logistics
export type Order = components["schemas"]["Order"];
export type OrderLineItem = components["schemas"]["OrderLineItem"];
export type Transaction = components["schemas"]["Transaction"];
export type Fulfillment = components["schemas"]["Fulfillment"];
export type ReturnAuthorization = components["schemas"]["ReturnAuthorization"];
export type Swap = components["schemas"]["Swap"];
export type OrderEdit = components["schemas"]["OrderEdit"];

// Customers
export type Customer = components["schemas"]["Customer"];
export type Address = components["schemas"]["Address"];
export type BusinessUnit = components["schemas"]["BusinessUnit"];
export type Quote = components["schemas"]["Quote"];

// Admin
export type SalesChannel = components["schemas"]["SalesChannel"];
export type Region = components["schemas"]["Region"];
export type Promotion = components["schemas"]["Promotion"];
export type DeadLetterJob = components["schemas"]["DeadLetterJob"];
export type DraftOrder = components["schemas"]["DraftOrder"];

// ============================================================================
// 3. REQUEST PAYLOAD DTOs (For Frontend API Client / Backend Validators)
// ============================================================================
export type InitializeCartRequest =
  components["schemas"]["InitializeCartRequest"];
export type AddLineItemRequest = components["schemas"]["AddLineItemRequest"];
export type AddCustomLineItemRequest =
  components["schemas"]["AddCustomLineItemRequest"];
export type UpdateLineItemQuantityRequest =
  components["schemas"]["UpdateLineItemQuantityRequest"];
export type ApplyDiscountRequest =
  components["schemas"]["ApplyDiscountRequest"];
export type MergeGuestCartRequest =
  components["schemas"]["MergeGuestCartRequest"];
export type SetShippingAddressRequest =
  components["schemas"]["SetShippingAddressRequest"];
export type PaymentSessionRequest =
  components["schemas"]["PaymentSessionRequest"];
export type PaystackWebhookEvent =
  components["schemas"]["PaystackWebhookEvent"];
export type SubmitReviewRequest = components["schemas"]["SubmitReviewRequest"];
export type AuthenticateRequest = components["schemas"]["AuthenticateRequest"];
export type RegisterCustomerRequest =
  components["schemas"]["RegisterCustomerRequest"];
export type InitiatePasswordResetRequest =
  components["schemas"]["InitiatePasswordResetRequest"];
export type CompletePasswordResetRequest =
  components["schemas"]["CompletePasswordResetRequest"];
export type AddressInput = components["schemas"]["AddressInput"];
export type CreateBusinessUnitRequest =
  components["schemas"]["CreateBusinessUnitRequest"];
export type RequestQuoteRequest = components["schemas"]["RequestQuoteRequest"];
export type ApproveQuoteRequest = components["schemas"]["ApproveQuoteRequest"];
export type ReturnRequest = components["schemas"]["ReturnRequest"];
export type SwapRequest = components["schemas"]["SwapRequest"];
export type ProposeOrderEditRequest =
  components["schemas"]["ProposeOrderEditRequest"];
export type ConfirmOrderEditRequest =
  components["schemas"]["ConfirmOrderEditRequest"];
export type DispatchFulfillmentRequest =
  components["schemas"]["DispatchFulfillmentRequest"];
export type CourierTrackingWebhook =
  components["schemas"]["CourierTrackingWebhook"];
export type CreateProductRequest =
  components["schemas"]["CreateProductRequest"];
export type CreateProductVariantRequest =
  components["schemas"]["CreateProductVariantRequest"];
export type AdjustInventoryRequest =
  components["schemas"]["AdjustInventoryRequest"];
export type ConfigureRegionalPricingRequest =
  components["schemas"]["ConfigureRegionalPricingRequest"];
export type CreatePromotionRequest =
  components["schemas"]["CreatePromotionRequest"];
export type CreateSalesChannelRequest =
  components["schemas"]["CreateSalesChannelRequest"];
export type CreateCategoryRequest =
  components["schemas"]["CreateCategoryRequest"];
export type ManageRolePermissionsRequest =
  components["schemas"]["ManageRolePermissionsRequest"];
export type BulkImportRequest = components["schemas"]["BulkImportRequest"];
export type DraftOrderRequest = components["schemas"]["DraftOrderRequest"];
export type SourcingRequest = components["schemas"]["SourcingRequest"];

// ============================================================================
// 4. SPECIFIC ENDPOINT RESPONSE ALIASES
// ============================================================================

// Catalog Context
export type ListProductsResponse =
  paths["/store/products"]["get"]["responses"][200]["content"]["application/json"];

export type SearchProductsResponse =
  paths["/store/products/search"]["get"]["responses"][200]["content"]["application/json"];

export type GetProductResponse =
  paths["/store/products/{id}"]["get"]["responses"][200]["content"]["application/json"];

export type GetRelatedProductsResponse =
  paths["/store/products/{id}/related"]["get"]["responses"][200]["content"]["application/json"];

export type GetVariantAvailabilityResponse =
  paths["/store/variants/{id}/availability"]["get"]["responses"][200]["content"]["application/json"];

export type ListCategoriesResponse =
  paths["/store/product-categories"]["get"]["responses"][200]["content"]["application/json"];

// Cart Context
export type InitializeCartResponse =
  paths["/store/carts"]["post"]["responses"][200]["content"]["application/json"];

export type GetCartResponse =
  paths["/store/carts/{id}"]["get"]["responses"][200]["content"]["application/json"];

// Checkout Context
export type GetShippingQuotesResponse =
  paths["/store/carts/{id}/shipping-quotes"]["post"]["responses"][200]["content"]["application/json"];

export type GetInsuranceQuoteResponse =
  paths["/store/carts/{id}/insurance-quote"]["post"]["responses"][200]["content"]["application/json"];

export type InitializePaymentSessionResponse =
  paths["/store/carts/{id}/payment-sessions"]["post"]["responses"][200]["content"]["application/json"];

export type PaymentWebhookAck =
  paths["/store/payments/webhook"]["post"]["responses"][200]["content"]["application/json"];

// Customers Context
export type AuthenticateCustomerResponse =
  paths["/store/auth"]["post"]["responses"][200]["content"]["application/json"];

export type RegisterCustomerResponse =
  paths["/store/customers"]["post"]["responses"][201]["content"]["application/json"];

export type GetCustomerProfileResponse =
  paths["/store/customers/me"]["get"]["responses"][200]["content"]["application/json"];

export type ListCustomerAddressesResponse =
  paths["/store/customers/me/addresses"]["get"]["responses"][200]["content"]["application/json"];

export type CreateBusinessUnitResponse =
  paths["/store/customers/me/business-units"]["post"]["responses"][201]["content"]["application/json"];

export type ListCustomerOrdersResponse =
  paths["/store/customers/me/orders"]["get"]["responses"][200]["content"]["application/json"];

// Logistics Context
export type GetOrderResponse =
  paths["/store/orders/{id}"]["get"]["responses"][200]["content"]["application/json"];

export type InitiateReturnResponse =
  paths["/store/orders/{id}/returns"]["post"]["responses"][201]["content"]["application/json"];

export type ProcessSwapResponse =
  paths["/store/orders/{id}/swaps"]["post"]["responses"][201]["content"]["application/json"];

export type ProposeOrderEditResponse =
  paths["/store/orders/{id}/edits"]["post"]["responses"][201]["content"]["application/json"];

export type ConfirmOrderEditResponse =
  paths["/store/order-edits/{id}/confirm"]["post"]["responses"][200]["content"]["application/json"];

// Admin Context
export type CreateProductResponse =
  paths["/admin/products"]["post"]["responses"][201]["content"]["application/json"];

export type CreateVariantResponse =
  paths["/admin/products/{id}/variants"]["post"]["responses"][201]["content"]["application/json"];

export type CreateSalesChannelResponse =
  paths["/admin/sales-channels"]["post"]["responses"][201]["content"]["application/json"];

export type CreateCategoryResponse =
  paths["/admin/categories"]["post"]["responses"][201]["content"]["application/json"];

export type EnqueueBulkImportResponse =
  paths["/admin/imports/bulk-catalog"]["post"]["responses"][202]["content"]["application/json"];

export type ListDeadLetterJobsResponse =
  paths["/admin/queues/{queue_name}/dead-letter"]["get"]["responses"][200]["content"]["application/json"];

export type CreateDraftOrderResponse =
  paths["/admin/draft-orders"]["post"]["responses"][201]["content"]["application/json"];

export type DetermineSourcingLocationResponse =
  paths["/admin/sourcing-location"]["post"]["responses"][200]["content"]["application/json"];

export type PruneAbandonedCartsResponse =
  paths["/admin/carts/prune"]["post"]["responses"][200]["content"]["application/json"];

export type TerminateStaleTransactionsResponse =
  paths["/admin/maintenance/stale-transactions"]["post"]["responses"][200]["content"]["application/json"];
