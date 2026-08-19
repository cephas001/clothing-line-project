import Link from "next/link";
import { getByCategory } from "@/lib/product";
import ProductGrid from "@/components/ProductsGrid/ProductGrid";
import Hero from "@/components/Hero/Hero";
import Marquee from "@/components/Marquee/Marquee";
export default function HomePage() {
  // Grabs the first 4 of each collection for the homepage teasers.
  const jackets = getByCategory("jackets").slice(0, 4);
  const jewelry = getByCategory("jewelry").slice(0, 4);
  const accessories = getByCategory("accessories").slice(0, 4);
  const offDuties = getByCategory("off-duties").slice(0, 4);

  return (
    <>
      <Hero />
      <Marquee />
    {/* Streetwear teaser */}
    <section className="px-4 pt-8 pb-4 md:px-8 md:pt-20 md:pb-10">
      <div className="mb-5 flex items-baseline justify-between gap-4 md:mb-8">
        <div>
            <div className="mb-1.5 font-mono text-[10px] tracking-[0.1em] text-muted md:mb-2 md:text-xs">
              [ 01 — JACKETS ]
            </div>
            <h2 className="m-0 font-display text-[22px] font-bold uppercase md:text-4xl">
              JACKETS
            </h2>
        </div>
        <Link
           href="/shop?category=jackets"
           className="whitespace-nowrap font-mono text-[10px] tracking-[0.08em] underline md:text-xs"
        >
          VIEW ALL
        </Link> 
        </div>
        <ProductGrid products={jackets} />
      </section>

    {/* Jewelry teaser */}
    <section className="px-4 pt-4 pb-14 md:px-8 md:pt-4 md:pb-24">
      <div className="mb-5 flex items-baseline justify-between gap-4 md:mb-8">
        <div>
            <div className="mb-1.5 font-mono text-[10px] tracking-[0.1em] text-muted md:mb-2 md:text-xs">
              [ 02 — JEWELRY ]
            </div>
            <h2 className="m-0 font-display text-[22px] font-bold uppercase md:text-4xl">
              JEWELRY
            </h2>
        </div>
        <Link
           href="/shop?category=jewelry"
           className="whitespace-nowrap font-mono text-[10px] tracking-[0.08em] underline md:text-xs"
        >
          VIEW ALL
        </Link> 
        </div>
        <ProductGrid products={jewelry} />
      </section>

    {/* Accessories teaser */}
    <section className="px-4 pt-4 pb-14 md:px-8 md:pt-4 md:pb-24">
      <div className="mb-5 flex items-baseline justify-between gap-4 md:mb-8">
        <div>
            <div className="mb-1.5 font-mono text-[10px] tracking-[0.1em] text-muted md:mb-2 md:text-xs">
              [ 03 — ACCESSORIES ]
            </div>
            <h2 className="m-0 font-display text-[22px] font-bold uppercase md:text-4xl">
              ACCESSORIES
            </h2>
        </div>
        <Link
           href="/shop?category=accessories"
           className="whitespace-nowrap font-mono text-[10px] tracking-[0.08em] underline md:text-xs"
        >
          VIEW ALL
        </Link> 
        </div>
        <ProductGrid products={accessories} />
      </section>

    {/* Off-duties teaser */}
    <section className="px-4 pt-4 pb-14 md:px-8 md:pt-4 md:pb-24">
      <div className="mb-5 flex items-baseline justify-between gap-4 md:mb-8">
        <div>
            <div className="mb-1.5 font-mono text-[10px] tracking-[0.1em] text-muted md:mb-2 md:text-xs">
              [ 04 — OFF-DUTIES ]
            </div>
            <h2 className="m-0 font-display text-[22px] font-bold uppercase md:text-4xl">
              OFF-DUTIES
            </h2>
        </div>
        <Link
           href="/shop?category=off-duties"
           className="whitespace-nowrap font-mono text-[10px] tracking-[0.08em] underline md:text-xs"
        >
          VIEW ALL
        </Link> 
        </div>
        <ProductGrid products={offDuties} />
      </section>
    </>
  );
}
