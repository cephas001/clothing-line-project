import Link from "next/link";

export default function HomePage() {
  // Grab the first 4 of each collection for the homepage teasers.
  // const streetwear = getByCategory("streetwear").slice(0, 4);
  // const jewelry = getByCategory("jewelry").slice(0, 4);

  return (
    <>
    {/* Hero and Marquee components to be added */}
    {/* --- Streetwear teaser --- */}
    <section className="px-4 pt-8 pb-4 md:px-8 md:pt-20 md:pb-10">
      <div className="mb-5 flex items-baseline justify-between gap-4 md:mb-8">
        <div>
            <div className="mb-1.5 font-mono text-[10px] tracking-[0.1em] text-muted md:mb-2 md:text-xs">
              [ 01 — STREETWEAR ]
            </div>
            <h2 className="m-0 font-display text-[22px] font-bold uppercase md:text-4xl">
              STREETWEAR
            </h2>
        </div>
        <Link
           href="/shop?category=streetwear"
           className="whitespace-nowrap font-mono text-[10px] tracking-[0.08em] underline md:text-xs"
        >
          VIEW ALL
        </Link> 
        </div>
        {/* <ProductGrid products={streetwear} /> */}
      </section>

    {/* --- Jewelry teaser --- */}
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
        {/* <ProductGrid products={jewelry} /> */}
      </section>
    </>
  );
}
