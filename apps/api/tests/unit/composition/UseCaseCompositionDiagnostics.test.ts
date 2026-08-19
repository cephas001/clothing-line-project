// apps/api/tests/unit/composition/UseCaseCompositionDiagnostics.test.ts
//
// DEV-OBS — UNIT: the use-case composition report classifies every unwired
// use case truthfully against the runtime being composed. The four statuses:
//
//   - wired: the use case was constructed with every dependency it requires.
//   - unavailable-missing-infrastructure: the missing dependency has NO
//     concrete adapter in the repository yet (a build task, not a config task).
//   - unavailable-missing-configuration: a concrete adapter exists but was not
//     constructed because its required configuration is absent (API runtime).
//   - deferred-by-design: the use case belongs to the other runtime's
//     responsibility (the Worker runtime wires no external services by design;
//     synchronous storefront/admin HTTP flows are API-only, and the L4/L5
//     invariant forbids the worker from creating shipments).
//
// The factories construct use cases eagerly (side-effect free), so an empty
// dependency bag is sufficient to exercise the report logic without any live
// infrastructure.

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { buildUseCases } from "@api/infrastructure/composition/useCases";
import type { UseCaseDependencies } from "@api/infrastructure/composition/useCases/types";
import { loadAppConfig } from "@api/infrastructure/composition/config";
import type { UseCaseReport } from "@api/infrastructure/composition/useCases/types";

/** Empty dependency bag: every external-service use case is reported unwired. */
function emptyDeps(): UseCaseDependencies {
  return {} as UseCaseDependencies;
}

function byName(report: UseCaseReport, useCase: string) {
  return report.unwired.find((u) => u.useCase === useCase);
}

/** The use cases the worker runtime's workers consume (all always-wired). */
const WORKER_REQUIRED = [
  "VerifyPaymentEventUseCase",
  "FinalizeOrderTransactionUseCase",
  "VerifySwapPaymentEventUseCase",
  "FinalizeSwapTransactionUseCase",
  "ProcessCourierTrackingEventUseCase",
];

describe("DEV-OBS — use-case composition diagnostics classification", () => {
  it("reports use cases with all dependencies as wired", () => {
    const report = buildUseCases(emptyDeps()).report;
    expect(report.wired.includes("BrowseCatalogUseCase")).toBe(true);
    expect(report.wired.includes("InitializeCartSessionUseCase")).toBe(true);
    expect(report.summary.wired).toBe(report.wired.length);
    expect(report.summary.wired).toBeGreaterThan(0);
  });

  it("a missing dependency with no adapter is missing infrastructure capability", () => {
    const api = buildUseCases(emptyDeps(), { runtime: "api" }).report;
    const worker = buildUseCases(emptyDeps(), { runtime: "worker" }).report;

    // ISearchService has no concrete adapter in the repository, so the status
    // is identical in BOTH runtimes — nobody has built it yet.
    for (const report of [api, worker]) {
      const search = byName(report, "SearchProductsUseCase");
      expect(search).toBeDefined();
      expect(search?.missingDependency).toBe("ISearchService");
      expect(search?.status).toBe("unavailable-missing-infrastructure");
      expect(search?.detail).toContain("ISearchService");
    }
  });

  it("the API runtime reports a config-gated adapter as missing configuration", () => {
    const report = buildUseCases(emptyDeps(), { runtime: "api" }).report;

    // PaystackPaymentService exists; PAYSTACK_SECRET_KEY is simply not set.
    const init = byName(report, "InitializePaymentSessionUseCase");
    expect(init).toBeDefined();
    expect(init?.missingDependency).toBe("IPaymentService");
    expect(init?.status).toBe("unavailable-missing-configuration");
    expect(init?.detail).toContain("PAYSTACK_SECRET_KEY");

    const dispatch = byName(report, "DispatchOrderFulfillmentUseCase");
    expect(dispatch?.status).toBe("unavailable-missing-configuration");
    expect(dispatch?.detail).toContain("SHIPBUBBLE_API_KEY");
  });

  it("the Worker runtime reports API-owned use cases as deferred by design", () => {
    const report = buildUseCases(emptyDeps(), { runtime: "worker" }).report;

    const addLine = byName(report, "AddCartLineItemUseCase");
    expect(addLine).toBeDefined();
    expect(addLine?.status).toBe("deferred-by-design");

    const init = byName(report, "InitializePaymentSessionUseCase");
    expect(init?.status).toBe("deferred-by-design");

    // Dispatch is deferred for the same reason AND carries the L4/L5 invariant
    // note so the worker can never be (mis)understood as a shipment creator.
    const dispatch = byName(report, "DispatchOrderFulfillmentUseCase");
    expect(dispatch?.status).toBe("deferred-by-design");
    expect(dispatch?.note).toContain("L4/L5 invariant");

    const returnAuth = byName(report, "InitiateReturnAuthorizationUseCase");
    expect(returnAuth?.status).toBe("deferred-by-design");
  });

  it("API and Worker classify the SAME use case differently", () => {
    const api = buildUseCases(emptyDeps(), { runtime: "api" }).report;
    const worker = buildUseCases(emptyDeps(), { runtime: "worker" }).report;

    const apiStatus = byName(api, "InitializePaymentSessionUseCase")?.status;
    const workerStatus = byName(
      worker,
      "InitializePaymentSessionUseCase",
    )?.status;
    expect(apiStatus).toBe("unavailable-missing-configuration");
    expect(workerStatus).toBe("deferred-by-design");
  });

  it("the worker-required use cases are wired and never labeled deferred", () => {
    const report = buildUseCases(emptyDeps(), { runtime: "worker" }).report;

    for (const required of WORKER_REQUIRED) {
      expect(report.wired.includes(required)).toBe(true);
      const entry = byName(report, required);
      expect(entry).toBeUndefined();
    }
    const deferred = report.unwired
      .filter((u) => u.status === "deferred-by-design")
      .map((u) => u.useCase);
    for (const required of WORKER_REQUIRED) {
      expect(deferred.includes(required)).toBe(false);
    }
  });

  it("an optional missing capability never crashes composition", () => {
    const api = buildUseCases(emptyDeps(), { runtime: "api" });
    const worker = buildUseCases(emptyDeps(), { runtime: "worker" });

    expect(api.useCases).toBeDefined();
    expect(worker.useCases).toBeDefined();

    // Summary counts must reconcile with the unwired list in both runtimes.
    for (const report of [api.report, worker.report]) {
      const { summary } = report;
      const counted =
        summary.unavailableMissingInfrastructure +
        summary.unavailableMissingConfiguration +
        summary.deferredByDesign;
      expect(counted).toBe(report.unwired.length);
    }
  });

  it("required configuration still fails fast at the config boundary", () => {
    // JWT_SECRET has no default; the token service refuses to operate without
    // it, so loadAppConfig throws instead of booting half-configured.
    let threw = false;
    try {
      loadAppConfig({});
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
