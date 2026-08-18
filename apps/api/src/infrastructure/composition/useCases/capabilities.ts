// apps/api/src/infrastructure/composition/useCases/capabilities.ts

// Runtime capability catalog + classification for the use-case composition
// report. This is the single source of truth for WHICH domain service
// interfaces have a concrete adapter in the repository and how construction is
// gated. It MUST stay in sync with the externalServices construction in
// infrastructure/composition/bootstrap.ts (API) and apps/worker/src/bootstrap.ts
// (worker): when an adapter is added or removed, update this catalog so the
// startup diagnostics stay truthful.
//
// The status of an unwired use case falls out of the ACTUAL composition graph —
// (a) the runtime being composed (which external services that runtime wires by
// design) and (b) whether a concrete adapter exists in the repository — so no
// use-case names are hardcoded here and the classification can never drift from
// reality. There are four statuses:
//
//   - wired: the use case was constructed with every dependency it requires.
//   - unavailable-missing-infrastructure: the missing dependency has NO
//     concrete adapter in the repository yet (a build task, not a config task).
//   - unavailable-missing-configuration: a concrete adapter exists but was not
//     constructed because its required configuration is absent (API runtime).
//   - deferred-by-design: the use case belongs to the other runtime's
//     responsibility. The Worker runtime wires no external services by design —
//     synchronous storefront/admin HTTP flows (pricing, payment initialization,
//     shipping quotes, fulfillment dispatch, return authorization, ...) are
//     API-only, and the L4/L5 invariant forbids the worker from creating
//     shipments. These are intentionally NOT constructed in the Worker.

export type RuntimeKind = "api" | "worker";

export type UseCaseAvailability =
  | "wired"
  | "unavailable-missing-infrastructure"
  | "unavailable-missing-configuration"
  | "deferred-by-design";

export interface ExternalServiceCapability {
  /** Concrete adapter class that implements the domain interface. */
  adapter: string;
  /**
   * Env var that gates construction. null when the adapter is always
   * constructed (DB-backed, no secret): RegionalPricingService and
   * RegionalTaxCalculationService.
   */
  configEnv: string | null;
}

/**
 * Domain service interfaces that HAVE a concrete adapter in the repository.
 * Any missing dependency NOT in this catalog has no implementation yet and is
 * classified unavailable-missing-infrastructure in EVERY runtime.
 */
export const EXTERNAL_SERVICE_CAPABILITIES: Record<
  string,
  ExternalServiceCapability
> = {
  IPaymentService: {
    adapter: "PaystackPaymentService",
    configEnv: "PAYSTACK_SECRET_KEY",
  },
  ILogisticsService: {
    adapter: "ShipbubbleLogisticsService",
    configEnv: "SHIPBUBBLE_API_KEY",
  },
  INotificationService: {
    adapter: "ResendNotificationService",
    configEnv: "NOTIFICATION_API_KEY",
  },
  IPricingService: { adapter: "RegionalPricingService", configEnv: null },
  ITaxCalculationService: {
    adapter: "RegionalTaxCalculationService",
    configEnv: null,
  },
};

export interface UnavailableClassification {
  status: Exclude<UseCaseAvailability, "wired">;
  detail: string;
}

/**
 * Classify an unwired use case from its missing dependency and the runtime
 * being composed. Truthful by construction: the status falls out of the actual
 * composition graph (which runtime, whether an adapter exists in the
 * repository) — no use-case names are hardcoded here.
 */
export function classifyUnwired(
  missingDependency: string,
  runtime: RuntimeKind,
): UnavailableClassification {
  const capability = EXTERNAL_SERVICE_CAPABILITIES[missingDependency];

  if (!capability) {
    return {
      status: "unavailable-missing-infrastructure",
      detail: `No implementation for ${missingDependency} exists in the repository yet; an adapter must be built and supplied via externalServices.`,
    };
  }

  if (runtime === "worker") {
    return {
      status: "deferred-by-design",
      detail: `The Worker runtime wires no external services by design; ${missingDependency} is supplied by ${capability.adapter} in the API runtime only.`,
    };
  }

  return {
    status: "unavailable-missing-configuration",
    detail: capability.configEnv
      ? `Set ${capability.configEnv} to construct ${capability.adapter}.`
      : `${capability.adapter} exists but was not supplied to this runtime.`,
  };
}