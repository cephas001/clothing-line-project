// apps/api/tests/unit/logging/PinoLoggerConfiguration.test.ts
//
// DEV-OBS logging: verify the development/production logging configuration
// without asserting cosmetic terminal output. Covers:
//   - resolveLogPretty: the single centralized environment distinction
//     (LOG_PRETTY=true/false explicit override; pretty only in non-production
//     interactive terminals otherwise).
//   - buildPinoOptions: pretty => pino-pretty transport; production => plain
//     structured JSON (no transport); redaction + level + component always.
//   - PinoLogger behavior: production output is line-delimited JSON with
//     redacted secrets and the runtime component; pretty output (via a spawned
//     child process, since the transport is a worker thread) is human-readable,
//     carries the [component] prefix, and still redacts secrets.
//   - PinoLogger.diagnostic: bootstrap summaries stay structured JSON in
//     production and render as genuinely multiline reports in development,
//     while ordinary structured logs remain single-line pretty records.
//   - useCaseReportLines: the shared startup tree stays deterministic and
//     compact (counts + "UseCase → dependency" entries, blank-line groups).

import { describe, it } from "../../harness/runner";
import { expect } from "../../harness/expect";
import { resolveLogPretty } from "@api/infrastructure/composition/config";
import {
  PinoLogger,
  buildPinoOptions,
} from "@api/infrastructure/services/PinoLogger";
import { useCaseReportLines } from "@api/infrastructure/composition/useCases/types";
import type { UseCaseReport } from "@api/infrastructure/composition/useCases/types";
import { Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Collect every record written by a Pino destination into line strings. */
function collect(): { stream: Writable; lines: () => string[] } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      Buffer.concat(chunks)
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0),
  };
}

describe("resolveLogPretty (centralized environment distinction)", () => {
  it("forces pretty when LOG_PRETTY=true, even in production or non-interactive", () => {
    expect(
      resolveLogPretty({ LOG_PRETTY: "true", NODE_ENV: "production" }, false),
    ).toBe(true);
    expect(resolveLogPretty({ LOG_PRETTY: "true" }, false)).toBe(true);
  });

  it("forces structured JSON when LOG_PRETTY=false, even in a dev TTY", () => {
    expect(resolveLogPretty({ LOG_PRETTY: "false" }, true)).toBe(false);
    expect(
      resolveLogPretty({ LOG_PRETTY: "false", NODE_ENV: "production" }, true),
    ).toBe(false);
  });

  it("defaults to pretty only in an interactive non-production terminal", () => {
    expect(resolveLogPretty({}, true)).toBe(true);
    expect(resolveLogPretty({ NODE_ENV: "development" }, true)).toBe(true);
  });

  it("defaults to JSON when stdout is not an interactive TTY (turbo/CI pipes)", () => {
    expect(resolveLogPretty({}, false)).toBe(false);
  });

  it("defaults to JSON in production regardless of TTY", () => {
    expect(resolveLogPretty({ NODE_ENV: "production" }, true)).toBe(false);
  });

  it("treats absent or whitespace LOG_PRETTY as unset (falls back to default)", () => {
    expect(resolveLogPretty({ LOG_PRETTY: "  " }, true)).toBe(true);
    expect(resolveLogPretty({ LOG_PRETTY: "" }, true)).toBe(true);
  });
});

describe("buildPinoOptions (logger configuration)", () => {
  it("produces plain structured JSON in production (no transport)", () => {
    const options = buildPinoOptions({ level: "info" });
    expect((options as { transport?: unknown }).transport).toBeUndefined();
    expect(options.level).toBe("info");
    expect(options.redact).toBeDefined();
  });

  it("wires the pino-pretty transport with a component-aware format when pretty", () => {
    const options = buildPinoOptions({
      pretty: true,
      component: "worker",
      level: "debug",
    });
    const transport = (options as { transport?: { target?: string; options?: Record<string, unknown> } })
      .transport;
    expect(transport).toBeDefined();
    expect(transport!.target).toBe("pino-pretty");
    const opts = transport!.options!;
    expect(opts.singleLine).toBe(true);
    expect(opts.translateTime).toBe("SYS:HH:MM:ss.l");
    expect(String(opts.messageFormat)).toContain("{component}");
    expect(String(opts.messageFormat)).toContain("msg");
    expect(String(opts.ignore)).toContain("component");
    expect(options.level).toBe("debug");
    expect(options.redact).toBeDefined();
  });

  it("attaches the runtime component as a base field without losing pid/hostname", () => {
    const options = buildPinoOptions({ component: "api" });
    const base = options.base as Record<string, unknown>;
    expect(base.component).toBe("api");
    expect(base.pid).toBe(process.pid);
    expect(typeof base.hostname).toBe("string");
  });

  it("applies the conservative default redaction list by default", () => {
    const options = buildPinoOptions({});
    const redact = options.redact as string[];
    for (const path of [
      "password",
      "*.password",
      "token",
      "*.token",
      "authorization",
      "*.authorization",
      "apiKey",
      "api_key",
      "secret",
      "cardNumber",
      "*.cardNumber",
      "cvv",
      "*.cvv",
      "cookie",
      "cookies",
      "x-api-key",
      "x-payment-signature",
    ]) {
      expect(redact.includes(path)).toBe(true);
    }
  });

  it("honors an explicit custom redaction override", () => {
    const options = buildPinoOptions({ redact: ["customSecret"] });
    expect(options.redact).toEqual(["customSecret"]);
  });
});

describe("PinoLogger behavior", () => {
  it("emits line-delimited JSON with redaction, component, and level in production", () => {
    const { stream, lines } = collect();
    const logger = new PinoLogger({
      level: "info",
      pretty: false,
      component: "api",
      stream,
    });
    logger.info(
      "hello production",
      { authorization: "Bearer top-secret", token: "tok-123", count: 3 },
    );
    const output = lines();
    expect(output.length).toBeGreaterThan(0);
    const record = JSON.parse(output[0]) as Record<string, unknown>;
    expect(record.msg).toBe("hello production");
    expect(record.level).toBe(30);
    expect(record.component).toBe("api");
    expect(record.count).toBe(3);
    expect(record.authorization).toBe("[Redacted]");
    expect(record.token).toBe("[Redacted]");
    expect(String(output[0])).not.toContain("top-secret");
    expect(String(output[0])).not.toContain("tok-123");
  });

  it("redacts nested secrets in JSON output", () => {
    const { stream, lines } = collect();
    const logger = new PinoLogger({
      level: "info",
      pretty: false,
      component: "worker",
      stream,
    });
    logger.info(
      "nested secret",
      { payment: { cardNumber: "4111111111111111", cvv: "123" } },
    );
    const record = JSON.parse(lines()[0]) as Record<string, unknown>;
    const payment = record.payment as Record<string, unknown>;
    expect(payment.cardNumber).toBe("[Redacted]");
    expect(payment.cvv).toBe("[Redacted]");
  });

  it("renders human-readable pretty output with component and redaction (child process)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-pretty-"));
    const script = join(dir, "pretty-smoke.ts");
    const sourceUrl = fileURLToPath(
      new URL("../../../src/infrastructure/services/PinoLogger.ts", import.meta.url),
    );
    writeFileSync(
      script,
      [
        `import { PinoLogger } from ${JSON.stringify(pathToFileURL(sourceUrl).href)};`,
        `const logger = new PinoLogger({ level: "info", pretty: true, component: "api" });`,
        `logger.info("pretty child smoke", { authorization: "Bearer ultra-secret-xyz", token: "tok-abc", count: 7 });`,
        `setTimeout(() => process.exit(0), 400);`,
      ].join("\n"),
      "utf8",
    );
    try {
      const require = createRequire(import.meta.url);
      const tsxCli = require.resolve("tsx/cli");
      const result = spawnSync(process.execPath, [tsxCli, script], {
        encoding: "utf8",
        timeout: 20_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `pretty child exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        );
      }
      const stdout = result.stdout ?? "";
      // Human-readable, not raw JSON.
      expect(stdout).toContain("pretty child smoke");
      expect(stdout).toContain("[api]");
      expect(stdout).not.toMatch(/^\{"level":/);
      // Redaction still applies through the pretty transport.
      expect(stdout).toContain("[Redacted]");
      expect(stdout).not.toContain("ultra-secret-xyz");
      expect(stdout).not.toContain("tok-abc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps custom base fields and level configuration intact", () => {
    const { stream, lines } = collect();
    const logger = new PinoLogger({
      level: "warn",
      pretty: false,
      component: "worker",
      base: { service: "notifications" },
      stream,
    });
    logger.info("suppressed by level", {});
    logger.warn("warning emitted", {});
    const records = lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.length).toBe(1);
    expect(records[0].msg).toBe("warning emitted");
    expect(records[0].component).toBe("worker");
    expect(records[0].service).toBe("notifications");
  });
});

describe("PinoLogger.diagnostic (bootstrap summary presentation)", () => {
  it("keeps the bootstrap summary structured JSON in production (api and worker)", () => {
    for (const component of ["api", "worker"]) {
      const { stream, lines } = collect();
      const logger = new PinoLogger({
        level: "info",
        pretty: false,
        component,
        stream,
      });
      logger.diagnostic(
        "Application bootstrap summary",
        "Port: 5000\nRedis: redis://localhost:6379",
      );
      const record = JSON.parse(lines()[0]) as Record<string, unknown>;
      expect(record.msg).toBe("Application bootstrap summary");
      expect(record.summary).toBe(
        "Port: 5000\nRedis: redis://localhost:6379",
      );
      expect(record.level).toBe(30);
      expect(record.component).toBe(component);
    }
  });

  it("renders the bootstrap summary multiline in development while ordinary logs stay single-line (child process)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-diagnostic-"));
    const script = join(dir, "diagnostic-smoke.ts");
    const sourceUrl = fileURLToPath(
      new URL("../../../src/infrastructure/services/PinoLogger.ts", import.meta.url),
    );
    writeFileSync(
      script,
      [
        `import { PinoLogger } from ${JSON.stringify(pathToFileURL(sourceUrl).href)};`,
        `const logger = new PinoLogger({ level: "info", pretty: true, component: "api" });`,
        `logger.diagnostic("Application bootstrap summary", "  Port: 5000\\n  Redis: redis://localhost:6379\\n\\n  Use cases\\n    Wired: 51\\n    Unwired: 13");`,
        `logger.info("Catalog browse completed", { salesChannelId: "123", authorization: "Bearer ultra-secret-xyz" });`,
        `setTimeout(() => process.exit(0), 400);`,
      ].join("\n"),
      "utf8",
    );
    try {
      const require = createRequire(import.meta.url);
      const tsxCli = require.resolve("tsx/cli");
      const result = spawnSync(process.execPath, [tsxCli, script], {
        encoding: "utf8",
        timeout: 20_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `diagnostic child exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        );
      }
      const stdout = result.stdout ?? "";
      // Multiline diagnostic: title + indented body lines rendered literally.
      expect(stdout).toContain("Application bootstrap summary");
      expect(stdout).toContain("\n  Port: 5000");
      expect(stdout).toContain("\n  Redis: redis://localhost:6379");
      expect(stdout).toContain("\n    Wired: 51");
      // In development the summary is the message — never a {summary:...} field.
      expect(stdout).not.toContain('"summary"');
      // Ordinary structured logs remain single-line pretty records.
      const ordinaryLines = stdout
        .split("\n")
        .filter((l) => l.includes("Catalog browse completed"));
      expect(ordinaryLines.length).toBe(1);
      expect(ordinaryLines[0]).toContain('{"salesChannelId":"123"');
      expect(ordinaryLines[0]).not.toContain("\\n");
      // Redaction still applies through the pretty transport.
      expect(stdout).toContain("[Redacted]");
      expect(stdout).not.toContain("ultra-secret-xyz");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("useCaseReportLines (shared bootstrap summary tree)", () => {
  it("renders a deterministic compact tree with counts and arrow entries", () => {
    const report: UseCaseReport = {
      wired: ["BrowseCatalogUseCase", "InitializeCartSessionUseCase"],
      unwired: [
        {
          useCase: "SearchProductsUseCase",
          missingDependency: "ISearchService",
          status: "unavailable-missing-infrastructure",
          detail:
            "No implementation for ISearchService exists in the repository yet; an adapter must be built and supplied via externalServices.",
        },
        {
          useCase: "InitializePaymentSessionUseCase",
          missingDependency: "IPaymentService",
          status: "unavailable-missing-configuration",
          detail: "Set PAYSTACK_SECRET_KEY to construct PaystackPaymentService.",
        },
        {
          useCase: "DispatchOrderFulfillmentUseCase",
          missingDependency: "ILogisticsService",
          status: "deferred-by-design",
          detail:
            "The Worker runtime wires no external services by design; ILogisticsService is supplied by ShipbubbleLogisticsService in the API runtime only.",
          note: "L4/L5 invariant: the worker must never create shipments.",
        },
      ],
      summary: {
        wired: 2,
        unavailableMissingInfrastructure: 1,
        unavailableMissingConfiguration: 1,
        deferredByDesign: 1,
      },
    };

    const lines = useCaseReportLines(report);
    const text = lines.join("\n");
    expect(text).toContain("Use cases");
    expect(text).toContain("  Wired: 2");
    expect(text).toContain("  Unwired: 3");
    expect(text).toContain("    Missing infrastructure: 1");
    expect(text).toContain("    Missing configuration: 1");
    expect(text).toContain("    Deferred by design: 1");
    expect(text).toContain(
      "SearchProductsUseCase → ISearchService",
    );
    expect(text).toContain(
      "InitializePaymentSessionUseCase → IPaymentService (set PAYSTACK_SECRET_KEY)",
    );
    expect(text).toContain(
      "DispatchOrderFulfillmentUseCase → ILogisticsService (L4/L5 invariant: the worker must never create shipments.)",
    );
    // Groups are separated by blank lines for scannability.
    expect(lines.includes("")).toBe(true);
    // Deterministic: same input produces identical output.
    expect(useCaseReportLines(report)).toEqual(lines);
  });
});