"use client";

import { createContext,useCallback, useEffect, useMemo, useContext, useRef, useState } from "react";
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

const TOAST_TTL_MS = 3000;

const ToastContext = createContext<ToastContextValue | undefined>(undefined)


export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([])
    // F8: every auto-dismiss timer is tracked so it can be cancelled when the
    // toast is dismissed early or the provider unmounts — no timer survives
    // its toast.
    const timersRef = useRef<Map<string, number>>(new Map());

    const dismissToast = useCallback((id: string) => {
        const timer = timersRef.current.get(id);
        if (timer !== undefined) {
            window.clearTimeout(timer);
            timersRef.current.delete(id);
        }
        setToasts(prev => prev.filter(t => t.id !== id))
    }, [])

    const showToast = useCallback((message: string) => {
        const id = crypto.randomUUID();
        const newToast = { id, message};
        setToasts((prev) => [...prev, newToast]);
        const timer = window.setTimeout(() => {
            timersRef.current.delete(id);
            setToasts(prev => prev.filter(t => t.id !== id));
        }, TOAST_TTL_MS);
        timersRef.current.set(id, timer);
    }, [])

    // Unmount cleanup: clear every pending auto-dismiss timer.
    useEffect(() => {
        const timers = timersRef.current;
        return () => {
            for (const timer of timers.values()) window.clearTimeout(timer);
            timers.clear();
        };
    }, []);

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