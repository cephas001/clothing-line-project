// apps/api/src/infrastructure/observability/instrumentation.ts

// Application bootstrap for OpenTelemetry.
//
// This is a SIDE-EFFECT module: importing it loads dotenv, starts the tracing
// SDK, and registers graceful shutdown. It MUST be the first import in the
// process entry point (server.ts) so that the SDK and its instrumentations are
// registered before express/pg/Kysely are ever loaded. In ESM, sibling imports
// evaluate in source order, so placing this import above `express` in server.ts
// guarantees the start-order contract.
//
// ESM instrumentation: CommonJS modules imported via ESM `import` bypass
// require-in-the-middle (which only patches `Module.prototype.require`), so an
// instrumentation that hooks the main package exports (Express) would never
// fire under the tsx dev flow. Installing `import-in-the-middle`'s synchronous
// loader hooks makes the ESM loader intercept those modules and invoke the same
// `Hook` instances the instrumentations create — this is what produces Express
// route spans. Requires a Node version with `module.registerHooks` support
// (`supportsSyncHooks`); on older versions registration is skipped and
// ESM-imported CJS modules are simply not patched.

import "dotenv/config";
import { diag } from "@opentelemetry/api";
import {
  register as registerIitmLoader,
  supportsSyncHooks,
} from "import-in-the-middle/register-hooks.mjs";
import { shutdownTelemetry, startTelemetry } from "./sdk";

if (startTelemetry()) {
  registerIitmLoaderForEsm();
  registerGracefulShutdown();
}

/**
 * Install `import-in-the-middle`'s synchronous loader hooks so that ESM imports
 * of CommonJS modules are intercepted and the instrumentations' ESM `Hook`s
 * fire. Must run before express/pg/Kysely are imported; this module is the
 * first import in the process entry point, satisfying the contract. No-op (with
 * a warning) on Node versions that do not support `module.registerHooks`.
 */
function registerIitmLoaderForEsm(): void {
  if (!supportsSyncHooks()) {
    diag.warn(
      "import-in-the-middle synchronous loader hooks are unsupported on this " +
        "Node version; Express route spans for ESM-imported modules will not be produced",
    );
    return;
  }
  registerIitmLoader();
}

/**
 * Flush pending spans and then re-raise the received signal so the process
 * terminates with its default disposition. The existing shutdown behavior is
 * preserved: no `process.exit()` is introduced; telemetry flush is only a
 * prerequisite before the normal termination path runs.
 */
function registerGracefulShutdown(): void {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void shutdownTelemetry().finally(() => {
      process.kill(process.pid, signal);
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
