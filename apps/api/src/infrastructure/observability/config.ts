// apps/api/src/infrastructure/observability/config.ts

// Environment-driven OpenTelemetry configuration.
//
// The observability layer owns reading OTel environment variables so that
// domain, application, and adapter code never touch them. All values use
// OpenTelemetry's standard variable names with local-development-friendly
// defaults. No vendor-specific credentials live here — the operator supplies
// OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_HEADERS at deploy time.

export interface OtelConfig {
  /** Master switch. When false the SDK is never started and no spans are produced. */
  enabled: boolean;
  /** Resource `service.name`. */
  serviceName: string;
  /** Resource `service.version`. */
  serviceVersion: string;
  /** Resource `deployment.environment`. */
  deploymentEnvironment: string;
  /** Base OTLP/HTTP endpoint (no signal path), e.g. `http://localhost:4318`. */
  otlpEndpoint: string;
  /** Headers sent with every OTLP export request, parsed from OTEL_EXPORTER_OTLP_HEADERS. */
  otlpHeaders: Record<string, string>;
}

const DEFAULT_ENDPOINT = "http://localhost:4318";

/**
 * Parse the standard `key=value,key=value` list used by
 * OTEL_EXPORTER_OTLP_HEADERS. Malformed pairs are skipped rather than throwing
 * so a typo cannot take the application down.
 */
function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }
  return headers;
}

export function loadOtelConfig(env: NodeJS.ProcessEnv = process.env): OtelConfig {
  return {
    enabled: (env.OTEL_ENABLED ?? "true").toLowerCase() === "true",
    serviceName: env.OTEL_SERVICE_NAME ?? "clothing-line-api",
    serviceVersion: env.OTEL_SERVICE_VERSION ?? env.npm_package_version ?? "0.0.0",
    deploymentEnvironment: env.OTEL_DEPLOYMENT_ENVIRONMENT ?? "development",
    otlpEndpoint: (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    otlpHeaders: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
  };
}
