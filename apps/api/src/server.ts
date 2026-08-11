// Start OpenTelemetry BEFORE any instrumented module (express, pg, Kysely) is
// imported. ESM evaluates sibling imports in source order, so this must stay
// the very first import in this file.
import "./infrastructure/observability/instrumentation";

import express from "express";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import YAML from "yaml";
import type { Server as HttpServer } from "http";

import { registerShutdownHook } from "./infrastructure/observability/instrumentation";
import { bootstrapApplication } from "./infrastructure/composition/bootstrap";

async function main(): Promise<void> {
  // The composition root constructs all infrastructure and use cases. It
  // performs no I/O. Background workers are NOT composed here — they run in
  // apps/worker (@clothing-line-project/worker).
  const runtime = bootstrapApplication();
  const logger = runtime.infrastructure.logger;

  const app = express();
  const port = runtime.config.port;

  // 1. Load the YAML file
  const fileContents = fs.readFileSync("./openapi.yaml", "utf8");
  const swaggerDocument = YAML.parse(fileContents);

  // 2. The Sanitization Fix: Stringify, escape the invisible characters, and re-parse
  const sanitizedDoc = JSON.parse(
    JSON.stringify(swaggerDocument)
      .replace(/\u2028/g, "\\u2028") // Escapes Line Separators
      .replace(/\u2029/g, "\\u2029"), // Escapes Paragraph Separators
  );

  // 3. Mount the Swagger UI middleware
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(sanitizedDoc));

  // 4. A simple health check route
  app.get("/", (req, res) => {
    res.json({
      message: "Lekki Fashion API is running. Visit /api-docs for documentation.",
    });
  });

  // 5. Start the HTTP server
  const server = app.listen(port, () => {
    logger.info("API server listening", {
      port,
      url: `http://localhost:${port}`,
    });
    logger.info("Application bootstrap summary", {
      summary: runtime.describe(),
    });
  });

  // 6. Graceful shutdown: stop accepting new connections, then close queue
  //    connections, the Postgres pool, and Redis. Registered as an OTel
  //    shutdown hook so cleanup runs before telemetry flush and process exit.
  //    Workers are not owned by this process (see apps/worker).
  registerShutdownHook(async () => {
    await closeHttpServer(server);
    await runtime.shutdown();
  });
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
