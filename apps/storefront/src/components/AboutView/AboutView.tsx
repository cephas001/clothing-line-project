"use client";

import { motion } from "framer-motion";
import ProductImage from "../ProductImage/ProductImage";

export default function AboutView() {
  return (
    <section className="px-4 pb-14 pt-6 md:px-8 md:pb-24 md:pt-10">
      {/* Breadcrumb */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="mb-2.5 font-mono text-[10px] tracking-[0.06em] text-muted md:mb-3 md:text-[12px] md:tracking-[0.08em]"
      >
        HOME / ABOUT
      </motion.div>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-center md:gap-16">
        {/* LEFT: image */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="relative aspect-[4/5] overflow-hidden bg-placeholder"
        >
          <ProductImage src="" alt="QUHÁ" label="BRAND" />
        </motion.div>

        {/* RIGHT: text */}
        <div>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="mb-3 font-mono text-[11px] tracking-[0.1em] text-muted md:mb-5 md:text-[12px]"
          >
            [ ABOUT THE BRAND ]
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="m-0 mb-8 font-display text-[clamp(28px,10vw,90px)] font-black uppercase leading-[0.9] md:mb-12"
          >
            QUHÁ
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="m-0 font-mono text-[16px] leading-relaxed text-ink md:text-[18px] md:leading-[1.7]"
          >
            QUHÁ is a contemporary streetwear brand built around presence,
            individuality and self-expression. We combine minimalism with bold
            street culture, creating pieces that communicate without needing to
            be loud.
          </motion.p>
        </div>
      </div>
    </section>
  );
}