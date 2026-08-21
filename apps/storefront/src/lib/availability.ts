// apps/storefront/src/lib/availability.ts
//
// F7.1 / G016 / G017 — truthful variant-availability presentation rules.
//
// Pure logic only (no React, no fetches): the server's inventory fields are
// classified into exactly three customer-facing states, a live availability
// DTO is merged into a ProductView without ever inventing stock or prices,
// and a latest-wins guard lets async callers discard stale responses so an
// older fetch can never overwrite a newer selection.
//
// TRUTH RULES: a backordered variant is orderable but NOT physically in
// stock; the UI must never imply otherwise and never invents fulfillment
// promises (ship windows, restock dates). All quantities/prices here are
// server-sourced values passed through untouched.

import type { VariantAvailability } from "@clothing-line-project/shared-types";
import type { ProductView, VariantView } from "./types";

/** The three truthful availability states a variant can be presented as. */
export type AvailabilityState = "in_stock" | "backorder" | "out_of_stock";

/**
 * Classify a variant from the server's own inventory fields:
 *   - inventoryQuantity > 0            → in_stock  (physically on hand)
 *   - inventoryQuantity = 0 + backorder→ backorder (orderable, NOT in stock)
 *   - inventoryQuantity = 0, no backorder → out_of_stock
 */
export function availabilityOf(variant: {
  inventoryQuantity: number;
  allowBackorder: boolean;
}): AvailabilityState {
  if (variant.inventoryQuantity > 0) return "in_stock";
  return variant.allowBackorder ? "backorder" : "out_of_stock";
}

/** A variant may be selected/orderable in the first two states only. */
export function isSelectable(state: AvailabilityState): boolean {
  return state === "in_stock" || state === "backorder";
}

/**
 * Merge a live VariantAvailability DTO (GET /store/variants/{id}/availability)
 * into a ProductView. Quantities/backorder flags are overwritten with the
 * server's fresh values; priceMinor is updated ONLY when the server provides
 * one (null means "no regional price on this endpoint" — a weaker signal than
 * the detail payload, so the displayed authoritative price is kept). Derived
 * flags (available/isSoldOut) are recomputed from the merged data. Returns the
 * SAME reference when nothing changed so callers can setState without loops.
 */
export function mergeAvailability(
  product: ProductView,
  availability: VariantAvailability,
): ProductView {
  const index = product.variants.findIndex(
    (variant) => variant.id === availability.variantId,
  );
  if (index === -1) return product;

  const current = product.variants[index];
  const nextVariant: VariantView = {
    ...current,
    inventoryQuantity: availability.inventoryQuantity,
    allowBackorder: availability.allowBackorder,
    available:
      availability.inventoryQuantity > 0 || availability.allowBackorder,
    priceMinor:
      availability.priceMinor != null ? availability.priceMinor : current.priceMinor,
  };

  const variants = [...product.variants];
  variants[index] = nextVariant;

  const isSoldOut = !variants.some((variant) => variant.available);
  if (
    nextVariant.inventoryQuantity === current.inventoryQuantity &&
    nextVariant.allowBackorder === current.allowBackorder &&
    nextVariant.available === current.available &&
    nextVariant.priceMinor === current.priceMinor &&
    isSoldOut === product.isSoldOut
  ) {
    return product;
  }

  return { ...product, variants, isSoldOut };
}

// -----------------------------------------------------------------------------
// G017 — latest-wins guard for async responses.
//
// Rapid interactions (switching variants, re-fetching details) can let older
// in-flight promises resolve AFTER newer ones. Each new operation takes a
// ticket via start(); a resolved response is applied only while its ticket is
// still active, so stale data can never overwrite a newer selection.
// -----------------------------------------------------------------------------

export interface LatestWinsGuard {
  /** Take a ticket for a new operation (monotonically increasing). */
  start: () => number;
  /** True only while no newer operation has started. */
  isActive: (ticket: number) => boolean;
}

export function createLatestWinsGuard(): LatestWinsGuard {
  let latest = 0;
  return {
    start: () => ++latest,
    isActive: (ticket: number) => ticket === latest,
  };
}
