"use client";

// apps/storefront/src/app/account/orders/[id]/page.tsx
//
// Order detail route. A client component: it resolves the order id from the
// URL and renders the order from `GET /store/orders/{id}` (see
// OrderDetailView) under the authenticated account context.

import { useParams } from "next/navigation";
import OrderDetailView from "@/components/OrderDetailView/OrderDetailView";

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params?.id ?? "";
  return <OrderDetailView orderId={orderId} />;
}