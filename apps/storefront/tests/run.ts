// apps/storefront/tests/run.ts
//
// Storefront service-layer verification suite entry point
// (`pnpm --filter @clothing-line-project/storefront test`).
//
// Imports every *.test.ts (registering suites) and runs them via the
// zero-dependency harness. env.ts MUST be imported first so its module-scope
// side effects (env vars + the in-memory window/localStorage shim) run before
// any storefront src module is evaluated. Any failure exits non-zero.
//
// The storefront package is CommonJS (no `"type": "module"`), so the harness
// runs in an async main rather than a top-level await; the in-process test
// server is closed before exit so the process drains cleanly.

import { runAll } from "./harness/runner";
import "./helpers/env";

// --- Unit (pure service-layer logic — no HTTP) ---
import "./unit/format.test";
import "./unit/errors.test";
import "./unit/cart.test";
import "./unit/cartSession.test";
import "./unit/fifoQueue.test";
import "./unit/paymentReturn.test";
import "./unit/orderReceipt.test";
import "./unit/addressPrefill.test";
import "./unit/orderPolling.test";
import "./unit/passwordReset.test";
import "./unit/addressEdit.test";
import "./unit/catalogProjections.test";
import "./unit/catalogFidelity.test";
import "./unit/catalogNav.test";
import "./unit/searchPresentation.test";
import "./unit/cartMutationRules.test";
import "./unit/authGates.test";
import "./unit/dialogA11y.test";
import "./unit/errorPresentation.test";
import "./unit/homeSections.test";
import "./unit/shopPresentation.test";
import "./unit/wishlistProjection.test";
import "./unit/checkoutGate.test";
import "./unit/purchasePresentation.test";
import "./unit/receiptRows.test";
import "./unit/authDrawerPresentation.test";
import "./unit/wishlistStorage.test";

// --- Integration (real HTTP against an in-process server) ---
import "./integration/apiClient.test";
import "./integration/authFlows.test";
import "./integration/catalogApi.test";
import "./integration/cartCheckoutApi.test";
import "./integration/cartSessionRecovery.test";
import "./integration/paymentReturnFlow.test";
import "./integration/orderDetailAccess.test";
import "./integration/identityFlows.test";
import "./integration/ordersApi.test";
import "./integration/addressLifecycle.test";

import { testServer } from "./helpers/testServer";

async function main(): Promise<void> {
  const result = await runAll();
  console.log(
    `\nStorefront service layer — ${result.passed}/${result.total} passed, ${result.failed} failed`,
  );
  await testServer.close();
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

void main();