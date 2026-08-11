// apps/api/src/infrastructure/observability/sdk.ts

// NodeSDK bootstrap for distributed tracing.
//
// This module is the single owner of the OpenTelemetry SDK: the tracer
// provider, the OTLP span exporter, the batch span processor, and the
// registered instrumentations (HTTP, Express, PostgreSQL). No code outside
// this directory may import `@opentelemetry/sdk-node` or the instrumentations.
//
// Start-order contract: this module must be evaluated and started BEFORE
// express, pg, and Kysely are imported, otherwise the instrumentations cannot
// wrap those modules. server.ts guarantees this by importing
// `./observability/instrumentation` as its very first import.

import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import { loadOtelConfig } from "./config";

let sdk: NodeSDK | null = null;

/**
 * OTEL_EXPORTER_OTLP_ENDPOINT is a base URL; the OTLP/HTTP exporter expects the
 * full signal URL. Append the traces path unless the operator already supplied it.
 */
function tracesUrl(endpoint: string): string {
  if (endpoint.endsWith("/v1/traces")) {
    return endpoint;
  }
  return `${endpoint}/v1/traces`;
}

/**
 * Builds and starts the NodeSDK. Returns `true` when tracing is active.
 * Idempotent: repeated calls return the existing SDK state.
 */
export function startTelemetry(): boolean {
  const config = loadOtelConfig();
  if (!config.enabled) {
    return false;
  }
  if (sdk) {
    return true;
  }

  const traceExporter = new OTLPTraceExporter({
    url: tracesUrl(config.otlpEndpoint),
    headers: config.otlpHeaders,
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: config.serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: config.serviceVersion,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: config.deploymentEnvironment,
    }),
    traceExporter,
    // NodeSDK wraps `traceExporter` in a BatchSpanProcessor internally when no
    // explicit span processor is supplied; no additional imports are needed.
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      // Patches the `pg` Pool/Client used underneath Kysely. Query spans become
      // children of the currently active request span via context propagation.
      new PgInstrumentation(),
    ],
  });

  sdk.start();
  return true;
}

/**
 * Flushes and shuts down the OpenTelemetry SDK. Safe to call when the SDK was
 * never started (no-op). Does not terminate the process.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) {
    return;
  }
  await sdk.shutdown();
  sdk = null;
}
