// apps/storefront/tests/unit/errors.test.ts
//
// Error normalization for the API client. Every backend failure arrives as the
// canonical StandardError envelope; the client maps it to a typed ApiError with
// a stable `code` the UI branches on, and network/unknown failures normalize to
// NETWORK_ERROR so callers never handle raw Error objects.

import { describe, it } from "../harness/runner";
import { expect } from "../harness/expect";
import {
  ApiError,
  isApiError,
  normalizeApiError,
} from "../../src/lib/api/errors";

describe("ApiError", () => {
  it("carries status, code and message", () => {
    const err = new ApiError({
      status: 401,
      code: "INVALID_CREDENTIALS",
      message: "Bad credentials.",
    });
    expect(err.status).toBe(401);
    expect(err.code).toBe("INVALID_CREDENTIALS");
    expect(err.message).toBe("Bad credentials.");
    expect(err).toBeInstanceOf(Error);
  });

  it("isApiError distinguishes ApiError instances", () => {
    const err = new ApiError({ status: 0, code: "NETWORK_ERROR", message: "x" });
    expect(isApiError(err)).toBe(true);
    expect(isApiError(new Error("plain"))).toBe(false);
  });

  it("normalizeApiError preserves an existing ApiError", () => {
    const err = new ApiError({ status: 404, code: "RESOURCE_NOT_FOUND", message: "gone" });
    expect(normalizeApiError(err)).toBe(err);
  });

  it("normalizeApiError maps an unknown Error to NETWORK_ERROR with its message", () => {
    const out = normalizeApiError(new Error("ECONNREFUSED"));
    expect(isApiError(out)).toBe(true);
    expect(out.code).toBe("NETWORK_ERROR");
    expect(out.status).toBe(0);
    expect(out.message).toBe("ECONNREFUSED");
  });

  it("normalizeApiError maps a non-Error to NETWORK_ERROR with the fallback", () => {
    const out = normalizeApiError("garbage");
    expect(out.code).toBe("NETWORK_ERROR");
    expect(out.message).toBe("Something went wrong.");
  });
});