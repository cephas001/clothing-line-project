"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useToast } from "@/context/ToastContext";

export default function Toaster() {
    const { toasts } = useToast();
    // F7 / G027 — the container is a polite live region so toast messages
    // (add-to-cart confirmations, errors) are announced by screen readers
    // without interrupting the current utterance.
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-6 right-6 z-[200] flex flex-col gap-2 pointer-events-none"
      >
            <AnimatePresence>
              {toasts.map((toast) => (
                <motion.div
                  key={toast.id}
                  initial= {{ opacity: 0, y: 20 }}
                  animate= {{opacity: 1, y: 0 }}
                  exit= {{ opacity: 0, y: 20 }}
                  transition= {{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  className="pointer-events-auto bg-ink text-paper-2 px-5 py-3.5 font-mono text-[12px] tracking-[0.05em] uppercase shadow-lg"
                >
                  {toast.message}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
    )
}
