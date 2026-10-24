#!/usr/bin/env bun
/**
 * pdf-service HTTP server
 *
 *   POST {prefix}/render                 { html, options? }                 → application/pdf
 *   POST {prefix}/fill                   { template, partials?, layout?, data?, tokens?, options? }
 *   POST {prefix}/templates/:name/render { data?, tokens?, options? }       → application/pdf
 *   GET  {prefix}/templates              names under TEMPLATES_DIR
 *   GET  {prefix}/health/live | /health/ready
 *
 * One Chrome is launched at startup and shared; every request gets its own tab.
 * HTML sent in the request body is untrusted: no local asset inlining, no scripts,
 * and the page may load only `data:` URLs plus PDF_ALLOWED_ORIGINS.
 * Templates under TEMPLATES_DIR are trusted (assets inlined from their directory).
 */

import { launchBrowser, type BrowserSession } from "./browser/launcher.ts";
import { renderHtmlToPdf, RenderError, type RenderOptions, type RenderResult } from "./render/print.ts";
import { PdfTemplate, loadTemplate } from "./template/document.ts";
import { TemplateError } from "./template/engine.ts";

export type ServerConfig = {
  port: number;
  prefix: string;
  templatesDir: string;
  /** Bearer token required on every non-health route; empty = no auth (internal network). */
  token: string;
  allowedOrigins: string[];
  /** Allow scripts in request-supplied HTML (and `waitForFunction`). */
  allowScripts: boolean;
  concurrency: number;
  maxBodyBytes: number;
  timeoutMs: number;
};

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  const list = (value?: string) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const int = (value: string | undefined, fallback: number) => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    port: int(env.PORT, 3000),
    prefix: (env.API_PREFIX ?? "/api/v1/pdf").replace(/\/$/, ""),
    templatesDir: (env.TEMPLATES_DIR ?? "./templates").replace(/\/$/, ""),
    token: env.PDF_SERVICE_TOKEN ?? "",
    allowedOrigins: list(env.PDF_ALLOWED_ORIGINS),
    allowScripts: env.PDF_ALLOW_SCRIPTS === "true",
    concurrency: int(env.PDF_CONCURRENCY, 4),
    maxBodyBytes: int(env.PDF_MAX_BODY_MB, 10) * 1024 * 1024,
    timeoutMs: int(env.PDF_TIMEOUT_MS, 30_000),
  };
}

/** Print options a client may set; browser, launch, inlining and request guards stay server-side. */
const CLIENT_OPTIONS = [
  "format", "landscape", "printBackground", "scale", "margin", "preferCSSPageSize", "pageRanges",
  "header", "footer", "headerFooterMargin", "watermark", "css", "mediaType", "outline", "tagged",
  "title", "waitForSelector", "waitForFunction", "waitAfterLoad", "timeoutMs",
] as const;

const TEMPLATE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors: Array<{ field: string; message: string }> | null = null,
  ) {
    super(message);
  }
}

/** Shared Chrome, relaunched if it dies, with a simple FIFO concurrency gate. */
class BrowserPool {
  #browser: Promise<BrowserSession> | null = null;
  #active = 0;
  #waiting: Array<() => void> = [];

  constructor(readonly concurrency: number) {}

  browser(): Promise<BrowserSession> {
    if (!this.#browser) {
      // The request guard (allowedOrigins) decides what a page may load, so Chrome's own
      // local-network block goes: templates must reach internal hosts such as storage-service.
      this.#browser = launchBrowser({
        disableFeatures: ["LocalNetworkAccessChecks", "BlockInsecurePrivateNetworkRequests", "PrivateNetworkAccessSendPreflights"],
      }).catch((error) => {
        this.#browser = null;
        throw error;
      });
      void this.#browser.then((session) =>
        session.process.exited.then(() => {
          console.error("[pdf-service] chrome exited, relaunching on next request");
          this.#browser = null;
        }),
      ).catch(() => {});
    }
    return this.#browser;
  }

  async run<T>(job: (browser: BrowserSession) => Promise<T>): Promise<T> {
    if (this.#active >= this.concurrency) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try {
      return await job(await this.browser());
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }

  async ready(): Promise<boolean> {
    try {
      const browser = await this.browser();
      await browser.connection.send("Browser.getVersion");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    const browser = await this.#browser?.catch(() => null);
    this.#browser = null;
    await browser?.close();
  }
}

export function createServer(config: ServerConfig = configFromEnv()) {
  const pool = new BrowserPool(config.concurrency);
  const { prefix } = config;

  function renderOptions(input: unknown, trusted: boolean): RenderOptions {
    if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
      throw new HttpError(400, "VALIDATION_FAILED", "Invalid request", [{ field: "options", message: "must be an object" }]);
    }
    const source = (input ?? {}) as Record<string, unknown>;
    const options: Record<string, unknown> = {};
    for (const key of CLIENT_OPTIONS) if (source[key] !== undefined) options[key] = source[key];
    const scripts = trusted || config.allowScripts;
    if (!scripts) delete options.waitForFunction;
    const timeout = typeof options.timeoutMs === "number" ? options.timeoutMs : config.timeoutMs;
    return {
      ...options,
      timeoutMs: Math.min(timeout, config.timeoutMs),
      allowedOrigins: config.allowedOrigins,
      javascript: scripts,
      ...(trusted ? {} : { inlineAssets: false }),
    } as RenderOptions;
  }

  function pdfResponse(result: RenderResult, filename: unknown): Response {
    const name = typeof filename === "string" && filename.trim() ? filename.trim() : "document.pdf";
    const safe = name.replace(/[^\w.\- ]/g, "_");
    return new Response(result.bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "X-Page-Count": String(result.pageCount),
        "X-Render-Ms": String(result.timings.totalMs),
      },
    });
  }

  async function readBody(request: Request): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, "VALIDATION_FAILED", "Body must be JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new HttpError(400, "VALIDATION_FAILED", "Body must be a JSON object");
    }
    return body as Record<string, unknown>;
  }

  function requireString(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new HttpError(400, "VALIDATION_FAILED", "Invalid request", [{ field, message: "must be a non-empty string" }]);
    }
    return value;
  }

  function optionalRecord<T>(body: Record<string, unknown>, field: string): Record<string, T> | undefined {
    const value = body[field];
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HttpError(400, "VALIDATION_FAILED", "Invalid request", [{ field, message: "must be an object" }]);
    }
    return value as Record<string, T>;
  }

  async function templateNames(): Promise<string[]> {
    const names: string[] = [];
    try {
      for await (const entry of new Bun.Glob("*/index.html").scan({ cwd: config.templatesDir })) {
        names.push(entry.slice(0, entry.indexOf("/")));
      }
    } catch {
      /* missing directory = no templates */
    }
    return names.filter((name) => TEMPLATE_NAME.test(name)).sort();
  }

  async function route(request: Request, path: string): Promise<Response> {
    const method = request.method;

    if (method === "GET" && path === `${prefix}/health/live`) return json(200, { status: "ok" }, path);
    if (method === "GET" && path === `${prefix}/health/ready`) {
      if (await pool.ready()) return json(200, { status: "ok", browser: "up" }, path);
      throw new HttpError(503, "PDF_BROWSER_UNAVAILABLE", "Chrome is not available");
    }

    if (config.token && request.headers.get("authorization") !== `Bearer ${config.token}`) {
      throw new HttpError(401, "PDF_UNAUTHORIZED", "Missing or invalid bearer token");
    }

    if (method === "GET" && path === `${prefix}/templates`) return json(200, await templateNames(), path);

    if (method === "POST" && path === `${prefix}/render`) {
      const body = await readBody(request);
      const html = requireString(body, "html");
      const options = renderOptions(body.options, false);
      const result = await pool.run((browser) => renderHtmlToPdf(html, { ...options, browser }));
      return pdfResponse(result, body.filename);
    }

    if (method === "POST" && path === `${prefix}/fill`) {
      const body = await readBody(request);
      const template = new PdfTemplate(
        { html: requireString(body, "template") },
        {
          partials: optionalRecord<string>(body, "partials"),
          template: { layout: typeof body.layout === "string" ? body.layout : undefined },
          tokens: optionalRecord<string | number>(body, "tokens"),
        },
      );
      const options = renderOptions(body.options, false);
      const data = optionalRecord<unknown>(body, "data") ?? {};
      const result = await pool.run((browser) => template.toPdf(data as never, { ...options, browser }));
      return pdfResponse(result, body.filename);
    }

    const named = method === "POST" && path.startsWith(`${prefix}/templates/`) && path.endsWith("/render")
      ? decodeURIComponent(path.slice(`${prefix}/templates/`.length, -"/render".length))
      : null;
    if (named !== null) {
      if (!TEMPLATE_NAME.test(named) || !(await Bun.file(`${config.templatesDir}/${named}/index.html`).exists())) {
        throw new HttpError(404, "PDF_TEMPLATE_NOT_FOUND", `Template not found: ${named}`);
      }
      const body = await readBody(request);
      const template = await loadTemplate(`${config.templatesDir}/${named}`, {
        tokens: optionalRecord<string | number>(body, "tokens"),
      });
      const options = renderOptions(body.options, true);
      const data = optionalRecord<unknown>(body, "data") ?? {};
      const result = await pool.run((browser) => template.toPdf(data as never, { ...options, browser }));
      return pdfResponse(result, body.filename ?? `${named}.pdf`);
    }

    throw new HttpError(404, "NOT_FOUND", `Cannot ${method} ${path}`);
  }

  const server = Bun.serve({
    port: config.port,
    maxRequestBodySize: config.maxBodyBytes,
    idleTimeout: Math.min(255, Math.ceil(config.timeoutMs / 1000) + 30),
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";
      const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
      try {
        return await route(request, path);
      } catch (error) {
        const failure = toHttpError(error);
        if (failure.status >= 500) console.error(`[pdf-service] ${request.method} ${path}`, error);
        return Response.json(
          {
            success: false,
            statusCode: failure.status,
            code: failure.code,
            message: failure.message,
            errors: failure.errors,
            path,
            timestamp: new Date().toISOString(),
            correlationId,
          },
          { status: failure.status, headers: { "X-Correlation-ID": correlationId } },
        );
      }
    },
  });

  return {
    server,
    pool,
    async stop() {
      server.stop(true);
      await pool.close();
    },
  };
}

function json(status: number, data: unknown, path: string): Response {
  return Response.json(
    { success: true, statusCode: status, message: "Success", data, meta: null, path, timestamp: new Date().toISOString() },
    { status },
  );
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof TemplateError) return new HttpError(422, "PDF_TEMPLATE_INVALID", error.message);
  if (error instanceof RenderError && /timed out/i.test(error.message)) {
    return new HttpError(504, "PDF_RENDER_TIMEOUT", error.message);
  }
  return new HttpError(500, "PDF_RENDER_FAILED", error instanceof Error ? error.message : String(error));
}

if (import.meta.main) {
  const config = configFromEnv();
  const app = createServer(config);
  // Warm Chrome so the first request does not pay the launch; failures surface on /health/ready.
  void app.pool.browser().then(
    (browser) => console.log(`[pdf-service] chrome ${browser.browser.version}`),
    (error) => console.error(`[pdf-service] chrome failed to start: ${error.message}`),
  );
  console.log(`[pdf-service] listening on :${app.server.port}${config.prefix}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void app.stop().finally(() => process.exit(0)));
  }
}
