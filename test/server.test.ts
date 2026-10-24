/**
 * HTTP service tests — a real server on a random port, sharing one real Chrome.
 * A probe server counts hits so the request guard is checked by what the page
 * actually fetched, not by inspecting the PDF.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, createServer } from "../src/server.ts";

let hits: string[] = [];
function record(request: Request): Response {
  hits.push(new URL(request.url).pathname);
  return new Response("body { color: red }", { headers: { "Content-Type": "text/css" } });
}
const probe = Bun.serve({ port: 0, fetch: record });
const probeOrigin = `http://127.0.0.1:${probe.port}`;
// A second origin that is never allow-listed.
const blocked = Bun.serve({ port: 0, fetch: record });
const blockedOrigin = `http://127.0.0.1:${blocked.port}`;

let app: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  const templatesDir = await mkdtemp(join(tmpdir(), "pdf-service-tpl-"));
  await mkdir(join(templatesDir, "hello"));
  await writeFile(join(templatesDir, "hello", "index.html"), "<h1>Xin chào {{name}}</h1><p>{{currency total \"VND\"}}</p>");
  app = createServer({
    ...configFromEnv({}),
    port: 0,
    templatesDir,
    token: "secret",
    allowedOrigins: [probeOrigin],
  });
  base = `http://127.0.0.1:${app.server.port}/api/v1/pdf`;
});

afterAll(async () => {
  await app.stop();
  probe.stop(true);
  blocked.stop(true);
});

const auth = { Authorization: "Bearer secret", "Content-Type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

describe("pdf-service HTTP", () => {
  test("health/live needs no token", async () => {
    const response = await fetch(`${base}/health/live`);
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("ok");
  });

  test("health/ready reports Chrome", async () => {
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(200);
  }, 60_000);

  test("rejects a missing token with the error envelope", async () => {
    const response = await post("/render", { html: "<p>x</p>" }, { "Content-Type": "application/json" });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, statusCode: 401, code: "PDF_UNAUTHORIZED" });
  });

  test("validates the body", async () => {
    const response = await post("/render", { html: "" });
    expect(response.status).toBe(400);
    expect((await response.json()).errors[0].field).toBe("html");
  });

  test("renders HTML to a PDF", async () => {
    const response = await post("/render", { html: "<h1>Hello</h1>", filename: "hello.pdf", options: { format: "A5" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-page-count")).toBe("1");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  }, 60_000);

  test("blocks requests outside the allowed origins", async () => {
    hits = [];
    const html = `<link rel="stylesheet" href="${blockedOrigin}/blocked.css"><img src="${blockedOrigin}/blocked.png">
      <link rel="stylesheet" href="${probeOrigin}/allowed/ok.css"><p>guarded</p>`;
    const response = await post("/render", { html });
    expect(response.status).toBe(200);
    expect(hits).toEqual(["/allowed/ok.css"]);
  }, 60_000);

  test("does not run scripts in request HTML", async () => {
    hits = [];
    const html = `<!doctype html><script>fetch("${probeOrigin}/allowed/script")</script>
      <head></head><body><img src="data:," onerror="fetch('${probeOrigin}/allowed/handler')"><p>no js</p></body>`;
    const response = await post("/render", { html });
    expect(response.status).toBe(200);
    expect(hits).toEqual([]);
  }, 60_000);

  test("fills an inline template", async () => {
    const response = await post("/fill", { template: "<p>{{words amount}}</p>", data: { amount: 1000 } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  }, 60_000);

  test("reports template syntax errors as 422", async () => {
    const response = await post("/fill", { template: "{{#items}}never closed" });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("PDF_TEMPLATE_INVALID");
  });

  test("lists and renders templates from TEMPLATES_DIR", async () => {
    const list = await fetch(`${base}/templates`, { headers: auth });
    expect((await list.json()).data).toEqual(["hello"]);

    const response = await post("/templates/hello/render", { data: { name: "Nguyên", total: 1250000 } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("hello.pdf");
  }, 60_000);

  test("unknown templates are 404, path traversal included", async () => {
    for (const name of ["missing", "..%2F..%2Fetc"]) {
      const response = await post(`/templates/${name}/render`, {});
      expect(response.status).toBe(404);
    }
  });
});
