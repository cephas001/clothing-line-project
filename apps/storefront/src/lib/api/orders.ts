// apps/storefront/src/lib/api/orders.ts
//
// Order read API functions.
//
// Types come exclusively from `@clothing-line-project/shared-types`. The order
// read is public in the spec, but the backend enforces customer ownership when
// a bearer identity IS presented — the storefront always presents one here
// (orders are only ever shown to their owner inside /account), so a foreign
// order id resolves to a 403 rather than leaking another customer's order.
//
//   GET /store/orders/{id} -> getOrder (bearer for ownership)

import { request } from "./client";
import type { GetOrderResponse } from "@clothing-line-project/shared-types";

export function getOrder(orderId: string): Promise<GetOrderResponse> {
  return request<GetOrderResponse>(
    `/store/orders/${encodeURIComponent(orderId)}`,
    { auth: true },
  );
}