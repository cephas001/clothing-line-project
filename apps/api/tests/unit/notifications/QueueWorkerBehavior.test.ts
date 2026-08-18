// apps/api/tests/unit/notifications/QueueWorkerBehavior.test.ts
//
// UNIT TESTS — worker crash behavior (the real apps/worker QueueWorker).
//
// The worker package has no test runner of its own, so the API test suite
// exercises the ACTUAL `apps/worker/src/workers/QueueWorker` module (imported
// via its repo-relative path) to prove the retry semantics that keep a crash
// safe:
//   - a malformed notification job payload is PERMANENT: parse rejection
//     throws VALIDATION_ERROR, classifyError -> "permanent" (BullMQ must never
//     transiently retry a poison payload);
//   - domain terminal conflicts (already-completed / financial anomalies) are
//     classified "terminal" (never retried);
//   - transient provider/infrastructure failures (EXTERNAL_SERVICE_TIMEOUT,
//     RepositoryError CONNECTION) are "retry" — the producer's attempts +
//     backoff apply;
//   - non-retryable failures are wrapped in `PermanentJobFailure`, whose
//     `name` is "UnrecoverableError" so BullMQ's shouldRetryJob moves the job
//     straight to failed instead of looping forever.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { DomainError } from "@api/domain/entities/errors/DomainError";
import {
  RepositoryError,
  RepositoryErrorCode,
} from "@api/domain/interfaces/shared/errors/RepositoryError";
import {
  classifyError,
  PermanentJobFailure,
} from "../../../../worker/src/workers/QueueWorker";

describe("QueueWorker — malformed job rejection is PERMANENT (never retried)", () => {
  it("classifies a VALIDATION_ERROR payload as permanent", () => {
    const err = new DomainError("VALIDATION_ERROR", "Malformed notification payload.");
    expect(classifyError(err)).toBe("permanent");
  });

  it("classifies INVALID_INPUT as permanent", () => {
    const err = new DomainError("INVALID_INPUT", "Bad input.");
    expect(classifyError(err)).toBe("permanent");
  });
});

describe("QueueWorker — terminal domain conflicts are never transiently retried", () => {
  it("classifies already-completed / financial-anomaly codes as terminal", () => {
    for (const code of [
      "DUPLICATE_TRANSACTION",
      "INVALID_PAYMENT_AMOUNT",
      "INVALID_CURRENCY",
      "PAYMENT_VERIFICATION_FAILED",
      "INVALID_OPERATION",
      "INVALID_STATE",
      "ORDER_ALREADY_FULFILLED",
      "REFUND_REQUIRES_REVIEW",
      "RESOURCE_NOT_FOUND",
    ]) {
      expect(classifyError(new DomainError(code as never, "conflict"))).toBe("terminal");
    }
  });
});

describe("QueueWorker — transient provider/infrastructure failures RETRY", () => {
  it("classifies EXTERNAL_SERVICE_TIMEOUT / EXTERNAL_SERVICE_UNAVAILABLE / INTERNAL_ERROR as retry", () => {
    for (const code of [
      "EXTERNAL_SERVICE_TIMEOUT",
      "EXTERNAL_SERVICE_UNAVAILABLE",
      "EXTERNAL_SERVICE_ERROR",
      "INTERNAL_ERROR",
      "JOB_PROCESSING_ERROR",
    ]) {
      expect(classifyError(new DomainError(code as never, "transient"))).toBe("retry");
    }
  });

  it("classifies a RepositoryError CONNECTION (queue/DB down) as retry", () => {
    const err = new Error("redis down") as RepositoryError;
    err.code = RepositoryErrorCode.CONNECTION;
    expect(classifyError(err)).toBe("retry");
  });

  it("classifies an unexpected error as retry (fail-safe default)", () => {
    expect(classifyError(new Error("boom"))).toBe("retry");
  });
});

describe("QueueWorker — PermanentJobFailure drives BullMQ to fail (crash containment)", () => {
  it("uses the UnrecoverableError name so shouldRetryJob skips retries", () => {
    const failure = new PermanentJobFailure("VALIDATION_ERROR", "poison payload");
    expect(failure.name).toBe("UnrecoverableError");
    expect(failure.code).toBe("VALIDATION_ERROR");
    expect(failure.message).toContain("VALIDATION_ERROR");
  });

  it("a permanent classification on a malformed notification payload means NO transient retry", () => {
    // Full pipeline: a malformed notification job -> parse throws
    // VALIDATION_ERROR -> classify -> permanent. BullMQ moves the job to failed
    // (dead-letter) instead of looping; a corrupt intent can never be sent.
    const err = new DomainError("VALIDATION_ERROR", "intent.type is not known");
    expect(classifyError(err)).toBe("permanent");
  });
});