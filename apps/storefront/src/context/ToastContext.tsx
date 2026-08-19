"use client";

import { createContext,useCallback, useMemo, useContext, useState } from "react";
import type { ReactNode } from "react";

interface Toast{
    id: string
    message: string
}

interface ToastContextValue{
    toasts: Toast[];
    showToast: (message: string) => void;
    dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)


export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([])

    const dismissToast = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id))
    }, [])

    const showToast = useCallback((message: string) => {
        const id = crypto.randomUUID();
        const newToast = { id, message};
        setToasts((prev) => [...prev, newToast]);
        setTimeout(
            () => {setToasts(prev => prev.filter(t => t.id !== id))}
            , 3000)
    }, [])

    const value = useMemo<ToastContextValue>(
        () => ({ toasts, showToast, dismissToast }),
        [toasts, showToast, dismissToast]
    );
    return(
        <ToastContext.Provider value={value}>
            {children}
        </ToastContext.Provider>
    )

}

export function useToast() {
    const context = useContext(ToastContext);
    if(!context) {
        throw new Error("useToast must be used inside <ToastProvider>")
    }
    return context
}