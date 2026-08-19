"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, Minus } from "lucide-react";

// Which row is open. -1 = none, 0 = details, 1 = shipping.
type Open = -1 | 0 | 1;

interface ProductAccordionsProps {
  description: string;
}

export default function ProductAccordions({ description }: ProductAccordionsProps) {
    // default set to open, so shopprs see this firstt
    const [open, setOpen] = useState<Open>(0);

    const toggle = (row: Open) => setOpen((cur) => (cur === row ? -1 : row));

    return (
    <div className="mt-6 border-t border-ink md:mt-8">
        {/*  DETAILS row  */}     
         <div className="border-b border-ink">
           <button
              type="button"
              onClick={() => toggle(0)}
              aria-expanded={open === 0}
              className="flex w-full cursor-pointer items-center justify-between border-none bg-transparent px-0 py-3.5 font-mono text-[11px] uppercase tracking-[0.06em] text-ink md:py-4 md:text-[12px] md:tracking-[0.08em]"
            >
              <span>DETAILS</span>
              {open === 0 ? <Minus size={16} strokeWidth={1.75}/> : <Plus size={16} strokeWidth={1.75}/>}  
            </button> 

           <AnimatePresence initial={false}>
            {open === 0 && (
            <motion.div
              className="overflow-hidden"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            >
               <p className="m-0 pb-4 font-display text-[13px] leading-relaxed text-[#3a3a3a] md:pb-5 md:text-[14px]">
                   {description || "No description available yet."} 
                </p> 
            </motion.div>                
            )}
            </AnimatePresence> 
         </div>  

         {/*  SHIPPING & RETURNS row  */}
        <div className="border-b border-ink">
            <button
                type="button"
                onClick={() => toggle(1)}
                aria-expanded={open === 1}
                className="flex w-full cursor-pointer items-center justify-between border-none bg-transparent px-0 py-3.5 font-mono text-[11px] uppercase tracking-[0.06em] text-ink md:py-4 md:text-[12px] md:tracking-[0.08em]"
            >
                <span>SHIPPING &amp; RETURNS</span>  
                {open === 1 ? <Minus size={16} strokeWidth={1.75} /> : <Plus size={16} strokeWidth={1.75} />}
            </button>
          <AnimatePresence initial={false}>
            {open === 1 && (
               <motion.div
                   className="overflow-hidden"
                   initial={{ height: 0, opacity: 0 }}
                   animate={{ height: "auto", opacity: 1 }}
                   exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                >
                <p className="m-0 pb-4 font-display text-[13px] leading-relaxed text-[#3a3a3a] md:pb-5 md:text-[14px]">
                    Standard shipping 3–5 business days (NGA). Free on all domestic orders. Final sale on jewelry; apparel returns accepted within 14 days, unworn with tags attached.
                </p>
                </motion.div> 
            )}
           </AnimatePresence>  
        </div>
    </div>
    )
}