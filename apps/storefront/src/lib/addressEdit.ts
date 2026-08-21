// apps/storefront/src/lib/addressEdit.ts
//
// G007 — address-book editing rules (pure logic, no React, no HTTP).
//
// Editing flow: preload the EXISTING server address into a form -> validate
// required fields -> PUT the whitelisted AddressInput -> 204 -> refetch the
// list authoritatively. The resulting address is NEVER fabricated locally;
// what the UI shows after saving comes from the refetch.
//
// Default-address limitation (documented, per the OpenAPI contract):
//   `isDefault` exists as a PER-ENTRY field on Address/AddressInput and PUT
//   persists it on that entry (server-side field merge). There is NO endpoint
//   that sets a book-wide default and the server does NOT demote other
//   entries' flags, so an exclusive "make this the default" action would
//   fabricate semantics the backend does not provide. The editor therefore
//   preserves the entry's existing `isDefault` untouched and offers no
//   default toggle.

import type { Address, AddressInput } from "@clothing-line-project/shared-types";

/** The fields the edit form exposes — all of them AddressInput schema fields. */
export interface EditableAddressForm {
  firstName: string;
  lastName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
}

/** Fields the customer MUST provide for a shippable address (mirrors checkout). */
const REQUIRED_FIELDS: ReadonlyArray<keyof EditableAddressForm> = [
  "firstName",
  "lastName",
  "phone",
  "line1",
  "city",
  "state",
  "postalCode",
  "countryCode",
];

/** Preload the existing server address into editable form fields. */
export function addressToEditForm(address: Address): EditableAddressForm {
  return {
    firstName: address.firstName ?? "",
    lastName: address.lastName ?? "",
    phone: address.phone ?? "",
    line1: address.line1 ?? "",
    line2: address.line2 ?? "",
    city: address.city ?? "",
    state: address.state ?? "",
    postalCode: address.postalCode ?? "",
    countryCode: address.countryCode ?? "",
  };
}

/** Per-field error messages; empty object means the form is valid. */
export function validateAddressForm(
  form: EditableAddressForm,
): Partial<Record<keyof EditableAddressForm, string>> {
  const errors: Partial<Record<keyof EditableAddressForm, string>> = {};
  for (const field of REQUIRED_FIELDS) {
    if (form[field].trim() === "") {
      errors[field] = "Required.";
    }
  }
  return errors;
}

/**
 * F10 — the first invalid field in REQUIRED_FIELDS order, or null. Pure and
 * deterministic so the form can focus exactly one input regardless of object
 * key order. This is required-field/whitespace UX only: NO postcode, country
 * or state rules are invented client-side — the server remains authoritative.
 */
export function firstInvalidField(
  errors: Partial<Record<keyof EditableAddressForm, string>>,
): keyof EditableAddressForm | null {
  for (const field of REQUIRED_FIELDS) {
    if (errors[field]) return field;
  }
  return null;
}

/**
 * Build the PUT payload from the form. ONLY AddressInput schema fields are
 * posted (whitelist — no id, no metadata, nothing else). Optional fields the
 * customer cleared are sent as undefined (omitted from JSON); `isDefault` is
 * preserved from the preloaded address, never invented.
 */
export function editFormToAddressInput(
  form: EditableAddressForm,
  existing: Pick<Address, "isDefault">,
): AddressInput {
  return {
    firstName: form.firstName.trim() || undefined,
    lastName: form.lastName.trim() || undefined,
    phone: form.phone.trim() || undefined,
    line1: form.line1.trim(),
    line2: form.line2.trim() || undefined,
    city: form.city.trim(),
    state: form.state.trim() || undefined,
    postalCode: form.postalCode.trim() || undefined,
    countryCode: form.countryCode.trim() || undefined,
    isDefault: existing.isDefault,
  };
}
