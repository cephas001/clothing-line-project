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
//
// Graceful shutdown: this module owns the process's SIGTERM/SIGINT handling
// so there is exactly ONE shutdown coordinator. Registered shutdown hooks (the
// application's composition root registers its cleanup via
// registerShutdownHook) run first — while the SDK is still active, so their
// spans are captured — then pending spans are flushed, then the signal is
// re-raised so the process terminates with its default disposition. The signal
// handler is registered unconditionally; when telemetry is disabled the flush
// is a no-op and cleanup still runs before termination.

import "dotenv/config";
import { diag } from "@opentelemetry/api";
import {
  register as registerIitmLoader,
  supportsSyncHooks,
} from "import-in-the-middle/register-hooks.mjs";
import { shutdownTelemetry, startTelemetry } from "./sdk";

if (startTelemetry()) {
  registerIitmLoaderForEsm();
}
registerGracefulShutdown();

/** Application cleanup hooks to run before telemetry flush on SIGTERM/SIGINT. */
const shutdownHooks: Array<() => Promise<void>> = [];

/**
 * Register an application shutdown routine. The composition root registers its
 * graceful shutdown (workers -> db pool -> redis) here so that cleanup runs
 * while the tracing SDK is still live and its spans can be flushed afterwards.
 * Hooks run in registration order and are all awaited; a failing hook is logged
 * and does not prevent the remaining hooks or termination.
 */
export function registerShutdownHook(callback: () => Promise<void>): void {
  if (typeof callback !== "function") {
    throw new TypeError("registerShutdownHook requires a function.");
  }
  shutdownHooks.push(callback);
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
 * Run every registered application shutdown hook, flush pending spans, and then
 * re-raise the received signal so the process terminates with its default
 * disposition. No `process.exit()` is introduced; telemetry flush is only a
 * prerequisite before the normal termination path runs. When telemetry is
 * disabled `shutdownTelemetry()` is a no-op and the re-raise still terminates.
 */
function registerGracefulShutdown(): void {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void (async () => {
      for (const hook of shutdownHooks) {
        try {
          await hook();
        } catch (err) {
          diag.error("Application shutdown hook failed", { err });
        }
      }
      await shutdownTelemetry();
      process.kill(process.pid, signal);
    })();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
