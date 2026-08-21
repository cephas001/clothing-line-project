// apps/storefront/src/lib/api/client.ts
//
// The single fetch wrapper for every storefront -> API call.
//
// Responsibilities:
//   - Base URL from NEXT_PUBLIC_API_URL (default http://localhost:5000).
//   - JSON serialization for request bodies; JSON parsing for responses.
//   - `Authorization: Bearer <token>` injection for authenticated calls.
//   - Storefront context headers (`region_id`, `sales_channel_id`) on catalog
//     reads — the backend scopes every variant's authoritative priceMinor to
//     the request's region.
//   - 204 (no-content) handling: mutations return 204, callers re-fetch the
//     affected resource.
//   - Error normalization: every non-2xx response is parsed as the canonical
//     StandardError envelope and thrown as an ApiError (see ./errors).
//
// SSR-safe: used by client components/effects and by server components
// (generateMetadata). The token store guards on `typeof window`; public reads
// never attach a token.

import { getToken } from "./auth";
import { ApiError } from "./errors";
import type { StandardError } from "@clothing-line-project/shared-types";

/**
 * Base URL for the API. Resolved at request time (not module load) so the
 * storefront can be pointed at any backend (defaults to the local API) — and
 * so the service layer can be integration-tested against an in-process server
 * by setting NEXT_PUBLIC_API_URL before a request.
 */
export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000";
}

/** Default storefront region (reg-storefront, NGN) provisioned by migration 0019. */
export const DEFAULT_REGION_ID =
  process.env.NEXT_PUBLIC_DEFAULT_REGION_ID ?? "";

/** Default storefront sales channel (channel-storefront) provisioned by migration 0019. */
export const DEFAULT_SALES_CHANNEL_ID =
  process.env.NEXT_PUBLIC_DEFAULT_SALES_CHANNEL_ID ?? "";

/** ISO-4217 currency of the default storefront region (display-only formatting). */
export const DEFAULT_REGION_CURRENCY = (
  process.env.NEXT_PUBLIC_DEFAULT_REGION_CURRENCY ?? "NGN"
).toUpperCase();

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /**
   * Attach the storefront region/sales-channel context headers. Required on
   * catalog reads (the backend rejects catalog requests without them) and on
   * cart initialization.
   */
  storefrontContext?: boolean;
  /** Attach `Authorization: Bearer <token>` when a token is stored. */
  auth?: boolean;
  headers?: Record<string, string>;
}

/** Perform an API request and return the parsed JSON payload (T). */
export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = "GET",
    body,
    storefrontContext = false,
    auth = false,
    headers = {},
  } = options;

  const requestHeaders = new Headers(headers);
  if (body !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
  }
  if (storefrontContext) {
    if (DEFAULT_REGION_ID) requestHeaders.set("region_id", DEFAULT_REGION_ID);
    if (DEFAULT_SALES_CHANNEL_ID) {
      requestHeaders.set("sales_channel_id", DEFAULT_SALES_CHANNEL_ID);
    }
  }
  if (auth) {
    const token = getToken();
    if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    headers: requestHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    throw errorFromEnvelope(payload, response.status);
  }

  return payload as T;
}

/** Map a response payload to an ApiError using the canonical error envelope. */
function errorFromEnvelope(payload: unknown, status: number): ApiError {
  const envelope = payload as Partial<StandardError> | null;
  const code = envelope?.error?.code;
  const message = envelope?.error?.message ?? "Request failed.";
  const details = envelope?.error?.details;
  if (code) {
    return new ApiError({ status, code, message, details });
  }
  return new ApiError({ status, code: "UNKNOWN_ERROR", message });
}