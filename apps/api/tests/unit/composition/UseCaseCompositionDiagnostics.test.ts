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
    expect(report.wired.includes("InitializeCartSessionUseCase")).toBe(true);
    expect(report.wired.includes("RetrieveCategoryTreeUseCase")).toBe(true);
    expect(report.summary.wired).toBe(report.wired.length);
    expect(report.summary.wired).toBeGreaterThan(0);
  });

  it("catalogue reads require the regional pricing service", () => {
    const report = buildUseCases(emptyDeps(), { runtime: "api" }).report;

    // Browse and product details resolve the AUTHORITATIVE per-variant price,
    // so without IPricingService they are unwired (RegionalPricingService is
    // DB-backed and always constructed in the API runtime, so the classification
    // is missing configuration, never missing infrastructure).
    for (const name of ["BrowseCatalogUseCase", "GetProductDetailsUseCase"]) {
      const entry = byName(report, name);
      expect(entry).toBeDefined();
      expect(entry?.missingDependency).toBe("IPricingService");
      expect(entry?.status).toBe("unavailable-missing-configuration");
    }
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

  it("F3.5 — the four read use cases are wired in BOTH runtimes", () => {
    // GetCart, GetCustomerProfile, GetCustomerAddresses and GetOrder depend only
    // on core repositories + audit/identity/logging (no external service), so
    // they MUST be constructed in the API runtime AND in the Worker runtime —
    // never reported as a gap or deferred. Their routes (GET /store/carts/{id},
    // GET /store/customers/me, GET /store/customers/me/addresses, GET
    // /store/orders/{id}) therefore work in any runtime that mounts the router.
    const readUseCases = [
      "GetCartUseCase",
      "GetCustomerProfileUseCase",
      "GetCustomerAddressesUseCase",
      "GetOrderUseCase",
    ];
    for (const runtime of ["api", "worker"] as const) {
      const report = buildUseCases(emptyDeps(), { runtime }).report;
      for (const name of readUseCases) {
        expect(report.wired.includes(name)).toBe(true);
      }
    }
  });

  it("PART 18 — pins the F3 runtime counts for API and Worker", () => {
    // The F3 phase leaves the composition graph at a KNOWN, verified state.
    // These counts document the four-status report for the reconciliation
    // report and catch any future drift (a use case added/removed/wired).
    // F3.5 adds the four missing read use cases (GetCart, GetCustomerProfile,
    // GetCustomerAddresses, GetOrder), all wired in every runtime.
    const api = buildUseCases(emptyDeps(), { runtime: "api" }).report;
    expect(api.summary.wired).toBe(53);
    expect(api.summary.unavailableMissingInfrastructure).toBe(6);
    expect(api.summary.unavailableMissingConfiguration).toBe(12);
    expect(api.summary.deferredByDesign).toBe(0);

    const worker = buildUseCases(emptyDeps(), { runtime: "worker" }).report;
    expect(worker.summary.wired).toBe(53);
    expect(worker.summary.unavailableMissingInfrastructure).toBe(6);
    expect(worker.summary.unavailableMissingConfiguration).toBe(0);
    expect(worker.summary.deferredByDesign).toBe(12);

    // The 12 config-gated use cases in the API runtime share the same set as
    // the 12 deferred-by-design use cases in the Worker runtime (the config
    // absent in the API is the config the worker never provisions by design).
    const apiConfig = api.unwired
      .filter((u) => u.status === "unavailable-missing-configuration")
      .map((u) => u.useCase)
      .sort();
    const workerDeferred = worker.unwired
      .filter((u) => u.status === "deferred-by-design")
      .map((u) => u.useCase)
      .sort();
    expect(apiConfig).toEqual(workerDeferred);
    expect(apiConfig).toHaveLength(12);

    // The six infra-gap use cases are identical in both runtimes.
    const infraApi = api.unwired
      .filter((u) => u.status === "unavailable-missing-infrastructure")
      .map((u) => u.useCase)
      .sort();
    const infraWorker = worker.unwired
      .filter((u) => u.status === "unavailable-missing-infrastructure")
      .map((u) => u.useCase)
      .sort();
    expect(infraWorker).toEqual(infraApi);
    expect(infraApi).toEqual([
      "AdjustInventoryLevelUseCase",
      "CreateOrderRiskAssessmentUseCase",
      "FetchEmbeddedInsuranceQuoteUseCase",
      "ReconcileOrphanedLocksUseCase",
      "ResolveCrossSellingProductsUseCase",
      "SearchProductsUseCase",
    ]);
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
