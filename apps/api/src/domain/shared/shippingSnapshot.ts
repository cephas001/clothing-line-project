// apps/api/src/domain/shared/shippingSnapshot.ts

// Provider-neutral mapping between the Cart's DURABLE shipping selection and
// the frozen OrderShippingSnapshot the ORDER records at checkout.
//
// The checkout total is built from the server-validated shipping selection on
// the cart (ShippingQuote -> applySelectedShippingQuote). At payment
// initialization that selection is frozen onto the durable payment obligation
// (mirroring the line-item freeze), and at finalization the order builds its
// OrderShippingSnapshot from that frozen data — never from today's rates or a
// mutable cart that may have drifted. These functions are the ONLY writers of
// that snapshot shape and keep the mapper provider-neutral (no Shipbubble
// types here); the logistics adapter consumes OrderShippingSnapshot verbatim.

import { Cart } from "@api/domain/entities/Cart";
import {
  OrderShippingSnapshot,
  ShipmentDestination,
  ShipmentParcelItem,
  ShippingOptionSelection,
} from "@api/domain/shared/contracts";

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Weight in kilograms from item metadata; null when unspecified (provider defaults apply). */
function readWeightKg(metadata: Record<string, unknown> | undefined): number | null {
  const raw = metadata?.["weightKg"];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return null;
}

/**
 * Compose the receiver/destination for a shipment from the cart's shipping
 * address + contact email. Mirrors the material inputs the logistics adapter
 * uses to fetch rates, so the frozen destination always matches what was rated.
 */
export function buildShipmentDestination(cart: Cart): ShipmentDestination {
  const address = cart.shippingAddress ?? {};
  const firstName = optionalString(address["firstName"]);
  const lastName = optionalString(address["lastName"]);
  const company = optionalString(address["company"]);
  const name =
    [firstName, lastName].filter((part): part is string => part !== null).join(" ").trim() ||
    company ||
    "";
  return {
    name,
    email: (cart.email ?? "").trim(),
    phone: optionalString(address["phone"]) ?? "",
    company,
    line1: optionalString(address["line1"]),
    line2: optionalString(address["line2"]),
    city: optionalString(address["city"]),
    state: optionalString(address["state"]),
    postalCode: optionalString(address["postalCode"]),
    countryCode: optionalString(address["countryCode"]),
  };
}

/**
 * Compose the parcel items to ship from the cart line items. `weightKg` is
 * read from item metadata exactly like the logistics adapter reads it at rate
 * time, so the frozen parcel matches what was rated.
 */
export function buildShipmentParcelItems(cart: Cart): ShipmentParcelItem[] {
  return cart.items.map((item) => ({
    lineItemId: item.id,
    title: item.title ?? "",
    description: optionalString(item.metadata?.["description"]),
    quantity: item.quantity,
    unitPriceMinor: item.unitPriceMinor,
    weightKg: readWeightKg(item.metadata),
  }));
}

/**
 * Freeze the order's shipping snapshot from the cart's DURABLE selection.
 * Returns null when no selection has been applied (callers must guard with
 * `cart.hasShippingSelection` first).
 */
export function buildOrderShippingSnapshot(
  cart: Cart,
): OrderShippingSnapshot | null {
  if (!cart.hasShippingSelection) {
    return null;
  }
  const selection: ShippingOptionSelection = {
    quoteId: cart.shippingQuoteId ?? "",
    courierId: cart.shippingCourierId ?? "",
    serviceCode: cart.shippingServiceCode ?? "",
    serviceLevel: cart.shippingServiceLevel,
    amountMinor: cart.shippingAmountMinor ?? 0,
    currency: cart.shippingCurrency,
    etaDays: null,
  };
  return {
    requestToken: cart.shippingRequestToken ?? "",
    selection,
    destination: buildShipmentDestination(cart),
    parcelItems: buildShipmentParcelItems(cart),
    dimensions: null,
  };
}

/**
 * Validate/rebuild an OrderShippingSnapshot read back from the durable payment
 * obligation's metadata (an untrusted JSON round-trip). Returns null when the
 * value is absent or structurally invalid so callers can fall back defensively.
 */
export function toOrderShippingSnapshot(
  value: unknown,
): OrderShippingSnapshot | null {
  const raw = readRecord(value);
  if (!raw) {
    return null;
  }
  const requestToken = readStringField(raw, "requestToken")?.trim() ?? "";
  if (!requestToken) {
    return null;
  }

  const selectionRecord = readRecord(raw.selection);
  const courierId = readStringField(selectionRecord, "courierId")?.trim() ?? "";
  const serviceCode = readStringField(selectionRecord, "serviceCode")?.trim() ?? "";
  const amountMinor = readNumberField(selectionRecord, "amountMinor");
  if (
    !courierId ||
    !serviceCode ||
    amountMinor === null ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0
  ) {
    return null;
  }
  const selection: ShippingOptionSelection = {
    quoteId: readStringField(selectionRecord, "quoteId")?.trim() ?? "",
    courierId,
    serviceCode,
    serviceLevel: readStringField(selectionRecord, "serviceLevel"),
    amountMinor,
    currency: readStringField(selectionRecord, "currency"),
    etaDays: readNumberField(selectionRecord, "etaDays"),
  };

  const destinationRecord = readRecord(raw.destination);
  const destination: ShipmentDestination = {
    name: readStringField(destinationRecord, "name") ?? "",
    email: readStringField(destinationRecord, "email") ?? "",
    phone: readStringField(destinationRecord, "phone") ?? "",
    company: readStringField(destinationRecord, "company"),
    line1: readStringField(destinationRecord, "line1"),
    line2: readStringField(destinationRecord, "line2"),
    city: readStringField(destinationRecord, "city"),
    state: readStringField(destinationRecord, "state"),
    postalCode: readStringField(destinationRecord, "postalCode"),
    countryCode: readStringField(destinationRecord, "countryCode"),
  };

  const parcelItems: ShipmentParcelItem[] = [];
  if (Array.isArray(raw.parcelItems)) {
    for (const rawItem of raw.parcelItems) {
      const itemRecord = readRecord(rawItem);
      if (!itemRecord) {
        continue;
      }
      const lineItemId = readStringField(itemRecord, "lineItemId")?.trim() ?? "";
      const quantity = readNumberField(itemRecord, "quantity");
      const unitPriceMinor = readNumberField(itemRecord, "unitPriceMinor");
      if (
        !lineItemId ||
        quantity === null ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        unitPriceMinor === null ||
        !Number.isSafeInteger(unitPriceMinor) ||
        unitPriceMinor < 0
      ) {
        continue;
      }
      parcelItems.push({
        lineItemId,
        title: readStringField(itemRecord, "title") ?? "",
        description: readStringField(itemRecord, "description"),
        quantity,
        unitPriceMinor,
        weightKg: readNumberField(itemRecord, "weightKg"),
      });
    }
  }

  const dimensionsRecord = readRecord(raw.dimensions);
  let dimensions: OrderShippingSnapshot["dimensions"] = null;
  if (dimensionsRecord) {
    const length = readNumberField(dimensionsRecord, "length");
    const width = readNumberField(dimensionsRecord, "width");
    const height = readNumberField(dimensionsRecord, "height");
    if (length !== null && width !== null && height !== null) {
      dimensions = { length, width, height };
    }
  }

  return {
    requestToken,
    selection,
    destination,
    parcelItems,
    dimensions,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readNumberField(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
