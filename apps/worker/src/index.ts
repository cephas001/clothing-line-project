// apps/worker/src/index.ts

// Start OpenTelemetry BEFORE any instrumented module (pg, Kysely) is imported.
// ESM evaluates sibling imports in source order, so this must stay the very
// first import in this file. It also registers the shared SIGTERM/SIGINT
// shutdown coordinator (same instrumentation module the API process uses).
import "@api/infrastructure/observability/instrumentation";

import { registerShutdownHook } from "@api/infrastructure/observability/instrumentation";
import { bootstrapWorker } from "./bootstrap";

async function main(): Promise<void> {
  // The worker composition root constructs all infrastructure, use cases, and
  // workers. It performs no I/O and starts no workers on import — start() is
  // called explicitly below.
  const runtime = bootstrapWorker();
  const logger = runtime.infrastructure.logger;

  logger.diagnostic("Worker bootstrap summary", runtime.describe());

  // Graceful shutdown: stop workers first, then close queue connections, the
  // Postgres pool, and Redis. Registered as an OTel shutdown hook so cleanup
  // runs before telemetry flush and process exit.
  registerShutdownHook(async () => {
    await runtime.shutdown();
  });

  // Start background workers explicitly — never during module import.
  await runtime.start();
}

main().catch((err) => {
  // The composition root fails fast on missing required configuration; surface
  // the cause before exiting.
  console.error("Failed to bootstrap worker:", err);
  process.exit(1);
});
