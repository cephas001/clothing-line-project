// apps/api/tests/fixtures/regionFactory.ts

// Deterministic Region fixtures. The currency code is lowercased by the
// entity; shipping selections and obligations must agree with it.

import { Region, RegionProps } from "@api/domain/entities/Region";

export function buildRegion(
  overrides: Partial<RegionProps> = {},
): Region {
  return new Region({
    id: "region-ng",
    name: "Lagos",
    currencyCode: "ngn",
    taxRate: 1250,
    paymentProviders: ["paystack"],
    fulfillmentProviders: [],
    ...overrides,
  });
}