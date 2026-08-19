"use client"

import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp } from "lucide-react";

export default function BackToTop() {
    const [visible, setVisible] = useState<boolean>(false);

    useEffect(() => {
        const onScroll = () => {
            setVisible(window.scrollY > 400);
        }
        window.addEventListener("scroll", onScroll);

        return () => {
            window.removeEventListener("scroll", onScroll)
        }
    }, [])

    const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth"})
};

    return (
      <AnimatePresence>
        {visible && (
            <motion.button
            onClick={scrollToTop}
                transition={{ duration: 0.25 }}
                initial= {{opacity: 0, y: 12}} 
                animate= {{opacity: 1, y: 0 }}
                exit= {{ opacity: 0, y: 12}}
                aria-label= "Back to top"
                className="fixed flex items-center justify-center bottom-6 right-6 bg-ink text-paper-2 z-[90] h-11 w-11 rounded-full"
            >
                <ArrowUp size={20}/>
            </motion.button>
        )}
      </AnimatePresence>  
    )
}