// Start OpenTelemetry BEFORE any instrumented module (express, pg, Kysely) is
// imported. ESM evaluates sibling imports in source order, so this must stay
// the very first import in this file.
import "./infrastructure/observability/instrumentation";

import express from "express";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import YAML from "yaml";
import type { Express, Router } from "express";
import type { Server as HttpServer } from "http";

import { registerShutdownHook } from "./infrastructure/observability/instrumentation";
import { bootstrapApplication } from "./infrastructure/composition/bootstrap";
import type { ApplicationRuntime } from "./infrastructure/composition/bootstrap";
import type { ILogger } from "./domain/interfaces/shared/ILogger";
import {
  createNotFoundHandler,
  createTerminalErrorHandler,
} from "./adapters/http/errors";

async function main(): Promise<void> {
  // The composition root constructs all infrastructure and use cases. It
  // performs no I/O. Background workers are NOT composed here — they run in
  // apps/worker (@clothing-line-project/worker).
  const runtime = bootstrapApplication();
  const logger = runtime.infrastructure.logger;

  const app = express();
  const port = runtime.config.port;

  registerRoutes(app, runtime);

  // Start the HTTP server
  const server = app.listen(port, () => {
    logger.info("API server listening", {
      port,
      url: `http://localhost:${port}`,
    });
    logger.diagnostic("Application bootstrap summary", runtime.describe());
  });

  // Graceful shutdown: stop accepting new connections, then close queue
  // connections, the Postgres pool, and Redis. Registered as an OTel
  // shutdown hook so cleanup runs before telemetry flush and process exit.
  // Workers are not owned by this process (see apps/worker).
  registerShutdownHook(async () => {
    await closeHttpServer(server);
    await runtime.shutdown();
  });
}

/**
 * Deterministic route-registration order (Phases 18-20). This IS the routing
 * contract for the Express process:
 *
 *   1. OpenAPI docs + health check (no body parsing).
 *   2. RAW-BODY webhook routers FIRST — mounted before the global JSON parser
 *      so a webhook signature verifier sees the exact bytes (never a parsed
 *      object). If the global JSON parser ran first, express.raw inside the
 *      webhook routers would receive an empty stream.
 *   3. Global JSON parser for every storefront/admin JSON body.
 *   4. Storefront JSON routers under the established `/store` versioning.
 *   5. Terminal JSON 404 (unmatched routes) + canonical error handler.
 *
 * Routers that are NOT wired (webhooks without their dedicated secret, or
 * capability routers with unwired use cases) are simply not mounted; requests
 * to them fall through to the JSON 404 — they are never faked or weakened.
 */
function registerRoutes(
  app: Express,
  runtime: ApplicationRuntime,
): void {
  const logger = runtime.infrastructure.logger;

  // 1. Load the YAML file
  const fileContents = fs.readFileSync("./openapi.yaml", "utf8");
  const swaggerDocument = YAML.parse(fileContents);

  // The Sanitization Fix: Stringify, escape the invisible characters, and re-parse
  const sanitizedDoc = JSON.parse(
    JSON.stringify(swaggerDocument)
      .replace(/\u2028/g, "\\u2028") // Escapes Line Separators
      .replace(/\u2029/g, "\\u2029"), // Escapes Paragraph Separators
  );

  // 2. Mount the Swagger UI middleware
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(sanitizedDoc));

  // 3. A simple health check route
  app.get("/", (req, res) => {
    res.json({
      message: "Lekki Fashion API is running. Visit /api-docs for documentation.",
    });
  });

  // 4. Raw-body webhook routers FIRST (before any JSON parser). Each router
  //    verifies the provider signature against the RAW bytes and enqueues the
  //    mapped event — it never finalizes business state synchronously.
  mountIfPresent(app, "/store/payments/webhook", runtime.paymentWebhookRouter, logger);
  mountIfPresent(
    app,
    "/store/webhooks/shipbubble",
    runtime.logisticsWebhookRouter,
    logger,
  );

  // 5. Global JSON parser for all JSON request bodies.
  app.use(express.json({ limit: "100kb" }));

  // 6. Storefront JSON routers (the existing /store versioning convention).
  mountIfPresent(app, "/store", runtime.authRouter, logger);
  mountIfPresent(app, "/store", runtime.catalogRouter, logger);
  mountIfPresent(app, "/store/carts", runtime.paymentInitializationRouter, logger);
  mountIfPresent(app, "/store/carts", runtime.checkoutShippingRouter, logger);
  mountIfPresent(app, "/store/orders", runtime.swapRouter, logger);

  // 7. Terminal handlers: unmatched routes -> JSON 404; any remaining error ->
  //    canonical envelope. MUST be last.
  app.use(createNotFoundHandler(logger));
  app.use(createTerminalErrorHandler(logger));
}

/** Mount a router only when it is wired; log the mount for observability. */
function mountIfPresent(
  app: Express,
  path: string,
  router: Router | undefined,
  logger: ILogger,
): void {
  if (!router) {
    return;
  }
  app.use(path, router);
  logger.info("Route mounted", { path });
}

/**
 * Stop accepting new connections and wait for in-flight requests to finish,
 * force-closing any lingering keep-alive connections after a grace period.
 */
function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    const forceClose = setTimeout(() => {
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      resolve();
    }, 10_000);
    forceClose.unref?.();
    server.close(() => {
      clearTimeout(forceClose);
      resolve();
    });
  });
}

main().catch((err) => {
  // The composition root fails fast on missing required configuration; surface
  // the cause before exiting.
  console.error("Failed to bootstrap application:", err);
  process.exit(1);
});
