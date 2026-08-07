import { Suspense } from "react";

export const metadata = {
  title: "Shop All — Grey Wears",
};

export default function ShopPage() {
    // const products = getAllProducts();
    return (
        <Suspense
           fallback={<div className="min-h-[60vh]" />}
        >
          {/* <ShopView products={products} />   */}
        </Suspense>
    )
}