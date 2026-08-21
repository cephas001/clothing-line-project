// apps/storefront/tests/unit/addressEdit.test.ts
//
// Slice 3 — G007 address-editing rules (pure logic):
// preload from the existing server address, required-field validation, and a
// STRICTLY whitelisted AddressInput payload (proves no unsupported fields are
// posted; `isDefault` is preserved, never fabricated).

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  addressToEditForm,
  editFormToAddressInput,
  firstInvalidField,
  validateAddressForm,
} from "../../src/lib/addressEdit";
import { makeAddress } from "../helpers/fixtures";

describe("addressToEditForm — preload", () => {
  it("maps every editable field from the existing address", () => {
    const form = addressToEditForm(
      makeAddress({
        firstName: "Ada",
        lastName: "Lovelace",
        phone: "+2348000000000",
        line1: "1 Test Street",
        line2: "Suite 2",
        city: "Lagos",
        state: "LA",
        postalCode: "100001",
        countryCode: "NG",
      }),
    );
    expect(form).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      phone: "+2348000000000",
      line1: "1 Test Street",
      line2: "Suite 2",
      city: "Lagos",
      state: "LA",
      postalCode: "100001",
      countryCode: "NG",
    });
  });

  it("treats missing optional fields as empty strings", () => {
    const sparse = makeAddress({ line2: undefined, postalCode: undefined });
    const form = addressToEditForm(sparse);
    expect(form.line2).toBe("");
    expect(form.postalCode).toBe("");
  });
});

describe("validateAddressForm", () => {
  const VALID_FORM = addressToEditForm(makeAddress());

  it("accepts a complete form", () => {
    expect(validateAddressForm(VALID_FORM)).toEqual({});
  });

  it("flags every required field left blank (mirrors checkout requirements)", () => {
    const blank = addressToEditForm(makeAddress());
    blank.firstName = " ";
    blank.line1 = "";
    blank.city = "";
    const errors = validateAddressForm(blank);
    expect(errors.firstName).toBeDefined();
    expect(errors.line1).toBeDefined();
    expect(errors.city).toBeDefined();
    // Optional field stays unflagged.
    expect(errors.line2).toBeUndefined();
  });

  it("requires the country code", () => {
    const noCountry = { ...VALID_FORM, countryCode: "" };
    expect(validateAddressForm(noCountry).countryCode).toBeDefined();
  });
});

describe("editFormToAddressInput — whitelisted PUT payload", () => {
  it("posts ONLY AddressInput schema fields (no id, no metadata)", () => {
    const existing = makeAddress({ id: "addr-1", isDefault: true });
    const form = addressToEditForm(existing);
    form.line1 = "9 Edited Avenue";
    const payload = editFormToAddressInput(form, existing);

    // Exact shape equality: any unsupported key would fail this assertion.
    expect(payload).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      phone: "+2348000000000",
      line1: "9 Edited Avenue",
      line2: undefined,
      city: "Lagos",
      state: "LA",
      postalCode: "100001",
      countryCode: "NG",
      isDefault: true,
    });
    expect(Object.keys(payload).sort()).toEqual([
      "city",
      "countryCode",
      "firstName",
      "isDefault",
      "lastName",
      "line1",
      "line2",
      "phone",
      "postalCode",
      "state",
    ]);
  });

  it("preserves the entry's existing isDefault — never invents default status", () => {
    const notDefault = makeAddress({ isDefault: false });
    const form = addressToEditForm(notDefault);
    expect(editFormToAddressInput(form, notDefault).isDefault).toBe(false);

    const def = makeAddress({ isDefault: true });
    expect(editFormToAddressInput(addressToEditForm(def), def).isDefault).toBe(true);
  });

  it("trims values and drops cleared optional fields as undefined", () => {
    const existing = makeAddress({ isDefault: false });
    const form = addressToEditForm(existing);
    form.city = "  Abuja  ";
    form.line2 = "";
    form.postalCode = "   ";
    const payload = editFormToAddressInput(form, existing);
    expect(payload.city).toBe("Abuja");
    expect(payload.line2).toBeUndefined();
    expect(payload.postalCode).toBeUndefined();
  });
});

describe("firstInvalidField — F10 deterministic focus order", () => {
  it("returns the first required field with an error, in field order", () => {
    const blank = addressToEditForm(makeAddress());
    blank.firstName = " ";
    blank.line1 = "";
    blank.city = "";
    const errors = validateAddressForm(blank);
    expect(firstInvalidField(errors)).toBe("firstName");
  });

  it("skips valid fields and lands on the actual gap", () => {
    const onlyCity = { ...addressToEditForm(makeAddress()), city: "  " };
    expect(firstInvalidField(validateAddressForm(onlyCity))).toBe("city");
  });

  it("returns null for a valid form", () => {
    expect(firstInvalidField(validateAddressForm(addressToEditForm(makeAddress())))).toBeNull();
    expect(firstInvalidField({})).toBeNull();
  });
});
