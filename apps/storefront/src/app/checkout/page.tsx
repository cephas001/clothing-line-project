import { Suspense } from "react";
import CheckoutView from "@/components/CheckoutView/CheckoutView";

export const metadata = {
  title: "Checkout - QUHÁ",
};

export default function CheckoutPage() {
   return (
     <Suspense fallback={<div className="min-h-[70vh]" />}>
       <CheckoutView />
     </Suspense>
   );
}