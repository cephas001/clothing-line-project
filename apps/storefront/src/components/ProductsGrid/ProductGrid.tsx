import type { ProductView } from "@/lib/types";
import ProductCard from "../ProductCard/ProductCard";

interface ProductGridProps {
  products: ProductView[];
}

export default function ProductGrid({ products }: ProductGridProps) {
    if (products.length === 0) {
        return (
           <p className="py-10 font-mono text-[13px] tracking-[0.06em] text-muted">
                No products found.
            </p> 
        )
    }

    return (
        <div className="grid grid-cols-2 gap-px bg-ink md:grid-cols-3 lg:grid-cols-4">
            {products.map((product, i) => (
               <ProductCard key={product.id} product={product} index={i} /> 
            ))}
        </div>
    );
}