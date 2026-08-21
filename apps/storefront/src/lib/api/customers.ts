// apps/storefront/src/lib/api/customers.ts
//
// Customer identity + authentication API functions.
//
// Types come exclusively from `@clothing-line-project/shared-types`. Identity
// is ALWAYS derived from the authenticated session: the bearer token stored by
// AuthContext (never a client-supplied customerId). No backend credentials are
// ever embedded here or in the client.
//
//   POST /store/auth                  -> login      ({ accessToken })
//   POST /store/customers             -> register   (Customer, no token — caller logs in after)
//   GET  /store/customers/me          -> getMe      (Customer, bearer)
//   POST /store/customers/logout      -> logout     (204, bearer; Redis denylist)
//   GET  /store/customers/me/orders   -> getOrderHistory (bearer)
//   GET  /store/customers/me/addresses-> getAddresses (bearer)
//   POST /store/customers/me/addresses-> createAddress (bearer, 204)
//   PUT  /store/customers/me/addresses/{id} -> updateAddress (bearer, 204)
//   DELETE /store/customers/me/addresses/{id} -> deleteAddress (bearer, 204)
//   POST /store/customers/password-reset/initiate -> initiatePasswordReset (public, 204)
//   POST /store/customers/password-reset/complete -> completePasswordReset (public, 204)

import { request } from "./client";
import type {
  Address,
  AddressInput,
  AuthenticateCustomerResponse,
  AuthenticateRequest,
  Customer,
  ListCustomerOrdersResponse,
  RegisterCustomerRequest,
} from "@clothing-line-project/shared-types";

export function login(input: AuthenticateRequest): Promise<AuthenticateCustomerResponse> {
  return request<AuthenticateCustomerResponse>("/store/auth", {
    method: "POST",
    body: input,
  });
}

export function register(input: RegisterCustomerRequest): Promise<Customer> {
  return request<Customer>("/store/customers", {
    method: "POST",
    body: input,
  });
}

export function getMe(): Promise<Customer> {
  return request<Customer>("/store/customers/me", { auth: true });
}

/**
 * Best-effort server-side token denylist. F8: the caller clears the local
 * session FIRST and passes the captured token explicitly — the request must
 * never silently go out unauthenticated (the storage-backed `auth: true`
 * injection would find nothing after the local clear).
 */
export function logout(token?: string): Promise<void> {
  return request<void>("/store/customers/logout", {
    method: "POST",
    body: {},
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

export function getOrderHistory(
  params: { limit?: number; offset?: number } = {},
): Promise<ListCustomerOrdersResponse> {
  const query = new URLSearchParams();
  query.set("limit", String(params.limit ?? 10));
  query.set("offset", String(params.offset ?? 0));
  return request<ListCustomerOrdersResponse>(
    `/store/customers/me/orders?${query.toString()}`,
    { auth: true },
  );
}

export function getAddresses(): Promise<Address[]> {
  return request<Address[]>("/store/customers/me/addresses", { auth: true });
}

export function createAddress(input: AddressInput): Promise<void> {
  return request<void>("/store/customers/me/addresses", {
    method: "POST",
    auth: true,
    body: input,
  });
}

export function updateAddress(
  addressId: string,
  input: AddressInput,
): Promise<void> {
  return request<void>(
    `/store/customers/me/addresses/${encodeURIComponent(addressId)}`,
    {
      method: "PUT",
      auth: true,
      body: input,
    },
  );
}

export function deleteAddress(addressId: string): Promise<void> {
  return request<void>(
    `/store/customers/me/addresses/${encodeURIComponent(addressId)}`,
    { method: "DELETE", auth: true },
  );
}

// --- Password reset (G006; public routes, exact contract semantics) ---
//
// initiate: ALWAYS resolves 204 for a well-formed request — unknown emails are
// indistinguishable from known ones (anti-enumeration), so the UI must present
// the same "check your email" outcome either way. The reset token itself is
// only ever delivered by email; it is never logged or persisted here.
export function initiatePasswordReset(email: string): Promise<void> {
  return request<void>("/store/customers/password-reset/initiate", {
    method: "POST",
    body: { email },
  });
}

// complete: `{ resetToken, newPassword }` (8–256 chars per the schema).
// Invalid/expired/already-used tokens resolve to 401 UNAUTHORIZED_ACCESS.
export function completePasswordReset(
  resetToken: string,
  newPassword: string,
): Promise<void> {
  return request<void>("/store/customers/password-reset/complete", {
    method: "POST",
    body: { resetToken, newPassword },
  });
}