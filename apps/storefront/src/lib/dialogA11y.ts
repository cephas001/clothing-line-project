// apps/storefront/src/lib/dialogA11y.ts
//
// F8 Part 4 — overlay-dialog behavior (focus + keyboard), shared by the cart
// drawer, the auth drawer, and the mobile menu.
//
// Native <dialog> would provide this for free, but the drawers are animated
// Framer Motion panels; the behavior is instead factored into ONE hook so all
// three overlays behave identically:
//
//   - Escape closes the overlay.
//   - Tab / Shift+Tab CYCLE within the panel (no focus can escape behind the
//     backdrop while it is open).
//   - On open, focus moves into the panel (first focusable element).
//   - On close/unmount, focus returns to the element that opened the overlay.
//
// The pure decision helpers are exported for tests; the DOM work lives in the
// hook. No ARIA is invented here — the panels already carry role="dialog" +
// aria-label, which native semantics require.

import { useEffect, useRef } from "react";

/** Escape alone closes an open overlay; any modifier combination does not. */
export function isEscapeKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey
  );
}

/**
 * Pure tab-cycling math: the next index within a list of `count` focusables,
 * wrapping at both ends. Returns null when there is nothing to cycle (count
 * <= 1 keeps focus where it is — a single focusable traps harmlessly).
 */
export function nextTabWrap(
  currentIndex: number,
  count: number,
  shift: boolean,
): number | null {
  if (count < 2) return null;
  if (shift) return (currentIndex - 1 + count) % count;
  return (currentIndex + 1) % count;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export interface DialogOverlayOptions {
  /** Whether the overlay is currently open. */
  open: boolean;
  /** Close request (Escape). */
  onClose: () => void;
}

/**
 * Overlay behavior for an animated dialog panel. Attach the returned ref to
 * the panel element; while `open`, keyboard focus is contained and Escape
 * requests close. Focus is restored to the opener on close/unmount.
 */
export function useDialogOverlay<T extends HTMLElement = HTMLElement>({
  open,
  onClose,
}: DialogOverlayOptions) {
  const panelRef = useRef<T | null>(null);
  // The element to restore focus to when the overlay closes. Captured in a
  // ref so the cleanup closure never reads stale render state.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Move focus INTO the panel. Deferred to a task so the enter animation's
    // first paint happens and AnimatePresence has mounted the subtree.
    const focusTimer = window.setTimeout(() => {
      const target = focusableElements(panel)[0] ?? panel;
      target.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEscapeKey(event)) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusableElements(panel);
      const current = focusables.indexOf(
        document.activeElement as HTMLElement,
      );
      // Focus outside the panel (e.g. after a programmatic blur): pull it back
      // to the first focusable instead of letting it escape the overlay.
      const from =
        current === -1
          ? 0
          : nextTabWrap(current, focusables.length, event.shiftKey);
      if (from === null) return;
      if (current === -1) {
        focusables[0]?.focus();
        return;
      }
      event.preventDefault();
      focusables[from]?.focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      // Restore focus to the opener (or lose it gracefully if that element
      // was removed from the DOM while the overlay was open).
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore && restore.isConnected) restore.focus();
    };
    // `onClose` is stable in every call site (context callback / setState).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return panelRef;
}
