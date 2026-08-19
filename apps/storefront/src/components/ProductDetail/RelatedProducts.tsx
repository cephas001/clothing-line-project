import type { ProductView } from "@/lib/types";
import ProductGrid from "../ProductsGrid/ProductGrid";

interface RelatedProductsProps {
  products: ProductView[];
}

export default function RelatedProducts({ products }: RelatedProductsProps) {
   if (products.length === 0) return null;

   return (
    <div className="mt-14 md:mt-20">
      <div className="mb-4 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-6 md:text-[12px] md:tracking-[0.08em]">
        YOU MAY ALSO LIKE
      </div>
      <ProductGrid products={products} />
    </div>
   )
}