"use client";

import Link from "next/link";
import Image from "next/image";
import { motion, type Variants } from "framer-motion";
import { TypeAnimation } from "react-type-animation";
// F7/G023: /hero.jpg never existed (guaranteed 404 -> placeholder). The hero
// now uses an actual repository asset via a build-validated static import.
import heroVisual from "@/assets/QUHA'ALT4W.png";

// This controls a group of items.
// No special style when hidden 
// staggerChildren: Each child starts animating 0.12 seconds after the previous one
// delayChildren: Wait 0.1 seconds before starting the first child
const container: Variants = {
    hidden: {},
    visible: {
        transition: { staggerChildren: 0.12, delayChildren: 0.1}, 
    }
};

// Fade up animation
const item: Variants = {
    hidden: { opacity: 0, y: 24 },
    visible:{
        opacity: 1,
        y: 0,
        transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
    },
};

export default function Hero() {
    return (
        <section className="relative h-[70vh] min-h-[480px] overflow-hidden bg-ink md:h-[88vh]">
        <Image
            src={heroVisual}
            alt="QUHÁ brand visual"
            fill
            sizes="100vw"
            priority
            className="object-cover"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/5 from-40% to-black/85" />
        <motion.div
           className="absolute inset-x-0 bottom-0 p-6 md:p-14"
           variants={container}
           initial="hidden"
           animate="visible"
        >
           <motion.div
              variants={item}
              className="mb-3.5 font-mono text-[11px] tracking-[0.08em] text-paper-2 md:mb-5 md:text-[13px] md:tracking-[0.1em]"
            >
                [ NEW DROP — LIVE SOON ]
            </motion.div> 


            <motion.div
               variants={item}
               className="mb-5 max-w-[900px] md:mb-8"
            >
                <h1 className="m-0 max-w-[900px] font-display text-[clamp(36px,11vw,56px)] font-black uppercase leading-[0.95] text-paper-2 md:mb-8 md:text-[clamp(48px,9vw,128px)] md:leading-[0.92]">
                <TypeAnimation
                    sequence={[
                        "LOUD IN SILENCE.",
                        3000,
                        "BUILT TO OUTLAST TRENDS.",
                        3000,
                    ]}
                    speed={{ type: "keyStrokeDelayInMs", value: 160 }}
                    deletionSpeed={{ type: "keyStrokeDelayInMs", value: 180 }}
                    cursor={true}
                    repeat={Infinity}
                    wrapper="span"
                />
                </h1>
            </motion.div>
            
            <motion.div variants={item} className="mt-5 md:mt-0">
                <Link
                   href='/shop'
                   className="inline-block border border-paper-2 bg-transparent px-6 py-3.5 font-mono text-[12px] uppercase tracking-[0.1em] text-paper-2 hover:!bg-paper-2 hover:!text-ink hover:!opacity-100 md:px-9 md:py-4.5 md:text-[13px] md:tracking-[0.12em]"
                >
                    SHOP EVERYTHING
                </Link>
            </motion.div>
        </motion.div>
        </section>
    )
}