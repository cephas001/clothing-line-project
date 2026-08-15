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

  // 5. Mount the payment webhook (raw-body capture happens inside the router).
  //    Mounted only when PAYSTACK_WEBHOOK_SECRET is configured; the handler
  //    verifies the signature, maps the provider event, and enqueues it — it
  //    never finalizes an order synchronously.
  if (runtime.paymentWebhookRouter) {
    app.use("/store/payments/webhook", runtime.paymentWebhookRouter);
    logger.info("Payment webhook mounted", {
      path: "/store/payments/webhook",
    });
  }

  // 5b. Mount the payment-initialization endpoint (transport boundary only).
  //     Mounted only when the payment service is configured; the handler maps
  //     the request into InitializePaymentSessionUseCase and returns the
  //     application-level result. It never finalizes an order or accepts
  //     client-supplied financial values or payment status.
  if (runtime.paymentInitializationRouter) {
    app.use("/store/carts", runtime.paymentInitializationRouter);
    logger.info("Payment initialization mounted", {
      path: "/store/carts/:id/payment-sessions",
    });
  }

  // 5c. Mount the swap-payment endpoint (transport boundary only). Mounted only
  //     when the payment service is configured; the handler maps the request
  //     into ProcessOrderSwapVarianceUseCase and returns the application-level
  //     result. The client never supplies a financial value — the use case
  //     resolves the authoritative replacement price and creates the durable
  //     obligation before the gateway is contacted. It never finalizes a swap
  //     or accepts client-supplied payment status.
  if (runtime.swapRouter) {
    app.use("/store/orders", runtime.swapRouter);
    logger.info("Swap payment mounted", {
      path: "/store/orders/:orderId/swaps",
    });
  }

  // 5d. Mount the checkout-shipping endpoints (transport boundary only). The
  //     router is always present (selection depends only on core
  //     dependencies); the shipping-quotes route is registered only when a
  //     logistics service is configured. The handlers map the request into
  //     RetrieveDynamicShippingQuotesUseCase / SelectShippingOptionUseCase and
  //     return the application-level result. The client never supplies a
  //     shipping amount, currency, courier, or request token — the use cases
  //     resolve everything server-side from the persisted quote list.
  if (runtime.checkoutShippingRouter) {
    app.use("/store/carts", runtime.checkoutShippingRouter);
    logger.info("Checkout shipping mounted", {
      path: "/store/carts/:id/shipping-quotes, /store/carts/:id/shipping-options",
    });
  }

  // 5e. Mount the Shipbubble logistics webhook (raw-body capture happens inside
  //     the router). Mounted only when SHIPBUBBLE_WEBHOOK_SECRET is configured;
  //     the handler verifies the signature against the RAW bytes, maps the
  //     provider event (pure boundary transformation), and enqueues it — it
  //     never mutates fulfillment, creates shipments, calls Shipbubble, or
  //     opens a database transaction.
  if (runtime.logisticsWebhookRouter) {
    app.use("/store/webhooks/shipbubble", runtime.logisticsWebhookRouter);
    logger.info("Shipbubble webhook mounted", {
      path: "/store/webhooks/shipbubble",
    });
  }

  // 6. Start the HTTP server
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
