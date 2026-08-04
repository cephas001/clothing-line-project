// packages/shared-types/src/index.ts
import { components, paths } from "./api-types";

// 1. Export the base generated objects
export type { components, paths };

// 2. Export global reusable schemas
export type StandardError = components["schemas"]["StandardError"];
export type Price = components["schemas"]["Price"];
export type ProductVariant = components["schemas"]["ProductVariant"];
export type Product = components["schemas"]["Product"];
export type Category = components["schemas"]["Category"];
export type Collection = components["schemas"]["Collection"];
export type CartLineItem = components["schemas"]["CartLineItem"];
export type Cart = components["schemas"]["Cart"];
export type Order = components["schemas"]["Order"];
export type Transaction = components["schemas"]["Transaction"];
export type Customer = components["schemas"]["Customer"];
export type SalesChannel = components["schemas"]["SalesChannel"];
export type Region = components["schemas"]["Region"];
export type ReturnAuthorization = components["schemas"]["ReturnAuthorization"];
export type Swap = components["schemas"]["Swap"];
export type OrderEdit = components["schemas"]["OrderEdit"];

// 3. Export specific endpoint response aliases

// Store - Products
export type ListProductsSuccess =
  paths["/store/products"]["get"]["responses"]["200"]["content"]["application/json"];

export type GetProductSuccess =
  paths["/store/products/{id}"]["get"]["responses"]["200"]["content"]["application/json"];

// Store - Categories & Collections
export type ListProductCategoriesSuccess =
  paths["/store/product-categories"]["get"]["responses"]["200"]["content"]["application/json"];

export type GetVariantSuccess =
  paths["/store/variants/{id}"]["get"]["responses"]["200"]["content"]["application/json"];

export type ListCollectionsSuccess =
  paths["/store/collections"]["get"]["responses"]["200"]["content"]["application/json"];

// Admin
export type CreateSalesChannelSuccess =
  paths["/admin/sales-channels"]["post"]["responses"]["200"]["content"]["application/json"];

export type AddProductsToSalesChannelSuccess =
  paths["/admin/sales-channels/{id}/products"]["post"]["responses"]["200"]["content"]["application/json"];

export type CreateRegionSuccess =
  paths["/admin/regions"]["post"]["responses"]["200"]["content"]["application/json"];

export type UpdateRegionSuccess =
  paths["/admin/regions/{id}"]["put"]["responses"]["200"]["content"]["application/json"];

// Store - Cart
export type CreateCartSuccess =
  paths["/store/carts"]["post"]["responses"]["200"]["content"]["application/json"];

export type GetCartSuccess =
  paths["/store/carts/{id}"]["get"]["responses"]["200"]["content"]["application/json"];

export type AddLineItemSuccess =
  paths["/store/carts/{id}/line-items"]["post"]["responses"]["200"]["content"]["application/json"];

export type UpdateLineItemSuccess =
  paths["/store/carts/{id}/line-items/{line_id}"]["post"]["responses"]["200"]["content"]["application/json"];

export type DeleteLineItemSuccess =
  paths["/store/carts/{id}/line-items/{line_id}"]["delete"]["responses"]["200"]["content"]["application/json"];

export type AddShippingMethodSuccess =
  paths["/store/carts/{id}/shipping-methods"]["post"]["responses"]["200"]["content"]["application/json"];

export type InitializePaymentSessionsSuccess =
  paths["/store/carts/{id}/payment-sessions"]["post"]["responses"]["200"]["content"]["application/json"];

export type CompleteCheckoutSuccess =
  paths["/store/carts/{id}/complete"]["post"]["responses"]["200"]["content"]["application/json"];

// Store - Authentication
export type AuthenticateCustomerSuccess =
  paths["/store/auth"]["post"]["responses"]["200"]["content"]["application/json"];

export type CheckEmailExistsSuccess =
  paths["/store/auth/{email}"]["get"]["responses"]["200"]["content"]["application/json"];

// Store - Customers
export type RegisterCustomerSuccess =
  paths["/store/customers"]["post"]["responses"]["200"]["content"]["application/json"];

export type GetCurrentCustomerSuccess =
  paths["/store/customers/me"]["get"]["responses"]["200"]["content"]["application/json"];

// Logout has no application/json content, so no alias exported.

// Store - Orders
export type GetOrderSuccess =
  paths["/store/orders/{id}"]["get"]["responses"]["200"]["content"]["application/json"];

export type ListCustomerOrdersSuccess =
  paths["/store/orders/customer"]["get"]["responses"]["200"]["content"]["application/json"];

// Store - Returns / Swaps / Order Edits
export type CreateReturnSuccess =
  paths["/store/returns"]["post"]["responses"]["200"]["content"]["application/json"];

export type CreateSwapSuccess =
  paths["/store/swaps"]["post"]["responses"]["200"]["content"]["application/json"];

export type CreateOrderEditSuccess =
  paths["/store/order-edits/{id}"]["post"]["responses"]["200"]["content"]["application/json"];
