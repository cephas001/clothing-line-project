// apps/api/tests/run.ts
//
// L6 verification suite entry point (`pnpm --filter @clothing-line-project/api test`).
// Imports every *.test.ts (registering suites) and runs them via the harness.
// Any failure — especially a financial-invariant failure — exits non-zero.

import { runAll } from "./harness/runner";

// --- Unit (domain entity invariants) ---
import "./unit/payment/PaymentAmountInvariant.test";
import "./unit/cart/CartCheckoutBreakdown.test";

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

// --- Contract (transport boundary: forbidden financial fields) ---
import "./contract/payment/PaymentSessionTampering.test";
import "./contract/EndpointConformance.test";

const result = await runAll();

console.log(
  `\nL6 payment + logistics foundations — ${result.passed}/${result.total} passed, ${result.failed} failed`,
);

if (result.failed > 0) {
  process.exitCode = 1;
}