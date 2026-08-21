// apps/storefront/tests/helpers/testServer.ts
//
// A REAL in-process HTTP server used to integration-test the storefront API
// service layer without mocking `fetch`. The client speaks real HTTP to a
// `node:http` server on an ephemeral port; tests register deterministic
// route handlers (fixture-shaped responses from the shared-types contract) and
// assert what the client SENT (method, path, headers, body) and how it PARSED
// the response (JSON, 204, canonical error envelope).
//
// This is deliberately not a mock-everything test: the transport, header
// construction, body serialization, status handling and JSON parsing all run
// through the real client + real HTTP stack.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  raw: string;
}

export type HandlerContext = RecordedRequest;

export type RouteResult = { status: number; body?: unknown };

class TestServer {
  private server: ReturnType<typeof createServer> | null = null;
  private routes = new Map<string, (ctx: HandlerContext) => RouteResult | Promise<RouteResult>>();
  private listenPromise: Promise<string> | null = null;

  received: RecordedRequest[] = [];
  url = "";

  /** Register a handler for `METHOD path` (path is matched WITHOUT the query string). */
  when(
    method: string,
    path: string,
    handler: (ctx: HandlerContext) => RouteResult | Promise<RouteResult>,
  ): void {
    this.routes.set(`${method} ${path}`, handler);
  }

  /** Start the server on an ephemeral port (idempotent) and return its base URL. */
  async listen(): Promise<string> {
    if (this.listenPromise) return this.listenPromise;
    this.listenPromise = new Promise<string>((resolve) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void this.handle(req, res);
      });
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server?.address();
        const port =
          typeof address === "object" && address !== null ? address.port : 0;
        this.url = `http://127.0.0.1:${port}`;
        process.env.NEXT_PUBLIC_API_URL = this.url;
        resolve(this.url);
      });
    });
    return this.listenPromise;
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((err) => (err ? reject(err) : resolve()));
      });
      this.server = null;
    }
  }

  clearReceived(): void {
    this.received = [];
  }

  /** The most recently received request (undefined when none). */
  last(): RecordedRequest | undefined {
    return this.received[this.received.length - 1];
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.readBody(req);
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const record: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams.toString(),
      headers: { ...req.headers },
      body,
      raw,
    };
    this.received.push(record);

    const handler = this.routes.get(`${record.method} ${record.path}`);
    if (!handler) {
      this.respond(
        res,
        404,
        { success: false, error: { code: "RESOURCE_NOT_FOUND", message: "No route." } },
      );
      return;
    }

    let result: RouteResult;
    try {
      result = await handler(record);
    } catch (err) {
      this.respond(res, 500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: String(err) },
      });
      return;
    }

    if (result.status === 204) {
      res.statusCode = 204;
      res.end();
      return;
    }
    this.respond(res, result.status, result.body);
  }

  private respond(res: ServerResponse, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(payload === undefined ? "" : JSON.stringify(payload));
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

export const testServer = new TestServer();