import { Suspense } from "react";
import ShopView from "@/components/ShopView/ShopView";
import { getAllProducts } from "@/lib/product";

export const metadata = {
  title: "Shop All — QUHÁ",
};

export default function ShopPage() {
    const products = getAllProducts();
    return (
        <Suspense
           fallback={<div className="min-h-[60vh]" />}
        >
          <ShopView products={products} />  
        </Suspense>
    )
}