// apps/api/tests/run.ts
//
// L9 verification suite entry point (`pnpm --filter @clothing-line-project/api test`).
// Imports every *.test.ts (registering suites) and runs them via the harness.
// Any failure — especially a financial-invariant failure — exits non-zero.

import { runAll } from "./harness/runner";

// --- Unit (domain entity invariants) ---
import "./unit/payment/PaymentAmountInvariant.test";
import "./unit/cart/CartCheckoutBreakdown.test";

// --- Unit (L7 pricing, promotions & tax rules) ---
import "./unit/pricing/PricingRules.test";
import "./unit/promotions/PromotionRules.test";
import "./unit/tax/TaxRules.test";

// --- Unit (DEV-OBS: use-case composition diagnostics classification) ---
import "./unit/composition/UseCaseCompositionDiagnostics.test";

// --- Unit (DEV-OBS logging: dev/prod logger configuration + redaction) ---
import "./unit/logging/PinoLoggerConfiguration.test";

// --- Unit (L9 Part 26: inventory quantity validation + deterministic sourcing) ---
import "./unit/inventory/InventoryQuantityValidation.test";
import "./unit/inventory/DeterministicSourcingSelection.test";

// --- Unit (L9 Part 2: product read cache — keys, serialization, fail-open) ---
import "./unit/caching/ProductReadCache.test";

// --- Integration (authoritative payment lifecycle through the use cases) ---
import "./integration/payment/AuthoritativeAmount.test";
import "./integration/payment/HistoricalIntegrity.test";
import "./integration/payment/IdempotencyAndResetSafety.test";
import "./integration/payment/WebhookSecurity.test";
import "./integration/payment/DuplicateWebhooksAndConcurrency.test";
import "./integration/payment/RollbackAtomicity.test";
import "./integration/payment/FailureInjectionAndRetrySafety.test";
import "./integration/logistics/SwapVarianceAndRefund.test";

// --- Integration (L6 Part 3: logistics boundary — quotes, dispatch, webhook) ---
import "./integration/logistics/QuoteIntegrityAndSnapshotFreeze.test";
import "./integration/logistics/DispatchIdempotencyAndProviderIdentity.test";
import "./integration/logistics/LogisticsWebhookSecurityAndQueue.test";
import "./integration/logistics/LogisticsWorkerAndStateMachine.test";

// --- Integration (L7 checkout: authoritative chain + fail-closed components) ---
import "./integration/checkout/AuthoritativeCheckoutChain.test";
import "./integration/checkout/InsuranceQuoteFailClosed.test";

// --- Integration (L7 pricing, promotions & tax: use-case boundaries) ---
import "./integration/cart/ApplyDiscountCodeRules.test";
import "./integration/cart/AddCartLineItemPricingRules.test";
import "./integration/admin/PricingTaxPromotionAdmin.test";

// --- Integration (L9 Part 3: checkout reservation lifecycle + sourcing freeze) ---
import "./integration/inventory/ReservationLifecycleAndSourcingFreeze.test";

// --- Integration (L9 Part 26: concurrency, historical integrity, failure injection) ---
import "./integration/inventory/ConcurrentReservation.test";
import "./integration/inventory/HistoricalIntegrity.test";
import "./integration/inventory/FailureInjectionAndRetrySafety.test";

// --- Integration (L9 cleanup: the authoritative reservation path is the only reachable path) ---
import "./integration/inventory/AuthoritativeReservationPath.test";

// --- Integration (L9 Part 27: inventory must not weaken the financial architecture) ---
import "./integration/payment/InventoryPaymentIntegrity.test";

// --- Unit (L9 Part 28: the Shipbubble adapter uses the selected origin) ---
import "./unit/logistics/ShipbubbleOriginPropagation.test";

// --- E2E (L7 final criterion: full chain -> obligation -> Paystack -> snapshot) ---
import "./integration/l7/L7PricingTaxE2E.test";

// --- Contract (transport boundary: forbidden financial fields) ---
import "./contract/payment/PaymentSessionTampering.test";
import "./contract/EndpointConformance.test";

// --- Contract (API-L1 Phase 9/10: canonical request/error pipeline) ---
import "./contract/http/CanonicalErrorPipeline.test";

// --- Contract (API-L1 Phase 11/12: storefront auth + catalogue adapters) ---
import "./contract/auth/AuthRouter.test";
import "./contract/catalog/CatalogRouter.test";

// --- Contract (API-L1 Part 4: OpenAPI referential integrity) ---
import "./contract/spec/SpecIntegrity.test";

// --- Contract (API-L1 Part 4: logistics swap boundary HTTP contract) ---
import "./contract/logistics/SwapRouter.test";

// --- Unit (L8 notifications: contracts, money, templates, provider adapter) ---
import "./unit/notifications/NotificationContracts.test";
import "./unit/notifications/MoneyFormatting.test";
import "./unit/notifications/TemplateRendering.test";
import "./unit/notifications/ResendNotificationService.test";
import "./unit/notifications/QueueWorkerBehavior.test";
import "./unit/notifications/WorkerRegistryLifecycle.test";

// --- Integration (L8 notifications: outbox lifecycle, sweep, atomicity, security) ---
import "./integration/notifications/NotificationOutboxLifecycle.test";
import "./integration/notifications/EnqueueSweep.test";
import "./integration/notifications/NotificationFailureAtomicity.test";
import "./integration/notifications/RecipientSecurity.test";

// --- Integration (L8-R Part 3: outbox-migrated producers + retained direct-sync) ---
import "./integration/notifications/OutboxMigratedProducers.test";
import "./integration/notifications/PasswordResetDirectSync.test";

// --- Integration (L8-R Part 13: recipient-preference suppression) ---
import "./integration/notifications/NotificationPreferenceSuppression.test";

// --- E2E (L8-R Part 9/10/18: full notification pipeline + failure injection) ---
import "./integration/notifications/NotificationEndToEnd.test";

const result = await runAll();

console.log(
  `\nL9 inventory + sourcing + payment/logistics foundations — ${result.passed}/${result.total} passed, ${result.failed} failed`,
);

if (result.failed > 0) {
  process.exitCode = 1;
}