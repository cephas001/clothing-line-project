import type { Metadata } from "next";
import { listProducts } from "@/lib/api/catalog";
import ProductDetailPage from "@/components/ProductDetailPage/ProductDetailPage";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export const dynamic = "force-dynamic";

// Best-effort title: the API may be down at request/build time, so metadata
// degrades to the generic page title rather than failing the route.
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  try {
    const { items } = await listProducts({ limit: 100 });
    const product = items.find((p) => p.handle === slug);
    if (product) {
      return {
        title: `${product.title} - QUHÁ`,
        description: product.description ?? undefined,
      };
    }
  } catch {
    // API unreachable — fall through to the generic title.
  }
  return { title: "Shop — QUHÁ" };
}

export default async function ProductPage({ params }: PageProps) {
  const { slug } = await params;
  return <ProductDetailPage slug={slug} />;
}