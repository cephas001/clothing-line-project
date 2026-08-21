import { Suspense } from "react";
import ShopView from "@/components/ShopView/ShopView";

export const metadata = {
  title: "Shop All — QUHÁ",
};

export default function ShopPage() {
    return (
        <Suspense
           fallback={<div className="min-h-[60vh]" />}
        >
          <ShopView />
        </Suspense>
    )
}