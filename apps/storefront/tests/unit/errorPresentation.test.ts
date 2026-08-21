// apps/storefront/tests/unit/errorPresentation.test.ts
//
// F8 Part 4 — the single error-presentation rule (src/lib/errorPresentation.ts).
// Truthful backend messages pass through VERBATIM; only true transport
// failures get the curated network line; junk falls back to the generic
// sentence. No error surface may flatten a real message into
// "Something went wrong."

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import { ApiError } from "../../src/lib/api/errors";
import {
  NETWORK_ERROR_MESSAGE,
  errorMessageOf,
} from "../../src/lib/errorPresentation";

describe("errorMessageOf — truthful messages survive", () => {
  it("shows a backend envelope message verbatim", () => {
    const err = new ApiError({
      status: 401,
      code: "INVALID_CREDENTIALS",
      message: "Email or password is incorrect.",
    });
    expect(errorMessageOf(err)).toBe("Email or password is incorrect.");
  });

  it("shows a validation message verbatim", () => {
    const err = new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "postalCode is required.",
    });
    expect(errorMessageOf(err)).toBe("postalCode is required.");
  });
});

describe("errorMessageOf — transport failures", () => {
  it("rewords a normalized network failure into the actionable line", () => {
    const err = new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Failed to fetch",
    });
    expect(errorMessageOf(err)).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("normalizes a raw fetch TypeError (no response at all)", () => {
    expect(errorMessageOf(new TypeError("Failed to fetch"))).toBe(
      NETWORK_ERROR_MESSAGE,
    );
  });

  it("keeps a non-transport NETWORK_ERROR's own message", () => {
    // Defensive edge: NETWORK_ERROR on a real HTTP status is not transport.
    const err = new ApiError({
      status: 503,
      code: "NETWORK_ERROR",
      message: "Upstream unavailable.",
    });
    expect(errorMessageOf(err)).toBe("Upstream unavailable.");
  });
});

describe("errorMessageOf — unknown junk", () => {
  it("falls back to the generic sentence ONLY for non-Error values", () => {
    expect(errorMessageOf("boom")).toBe("Something went wrong.");
    expect(errorMessageOf(undefined)).toBe("Something went wrong.");
    expect(errorMessageOf(null)).toBe("Something went wrong.");
  });
});
