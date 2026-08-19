import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getAllProducts, getProductBySlug, getRelated } from "@/lib/product";
import ProductDetail from "@/components/ProductDetail/ProductDetail";
interface PageProps {
  params: Promise<{ slug: string }>;
}

// Build a static page for every product ahead of time.
// This tells Next every valid value of [slug].

export function generateStaticParams() {
  return getAllProducts().map((p) => ({ slug: p.slug }));
}

// Per-product <title> and description for browser tabs, Google, and shares.
export async function generateMetadata({
    params,
}: PageProps): Promise<Metadata> {
    // Unwrap the promise
    const { slug } = await params;
    const product = getProductBySlug(slug);
    if(!product) return { title: "Not found - Grey Wears"};
    return {
        title: `${product.name} - Grey Wears`,
        description: product.desc
    };
}

export default async function ProductPage({
    params,
}: PageProps){
    // Unwrap the promise
    const { slug } = await params;
    const product = getProductBySlug(slug);
    if(!product) notFound();

    const related = getRelated(product);
      // Server Component fetched the data → hands it to the interactive
      // Client Component that renders the gallery, size picker, add-to-cart, etc.
      return <ProductDetail product={product} related={related} />
}


