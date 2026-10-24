/**
 * Template-layer integration tests: real files on disk, real Chrome, real PDFs.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PdfTemplate, loadTemplate } from "../src/template/document.ts";
import { render } from "../src/template/engine.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pdf-service-"));
}

describe("PdfTemplate: inline source", () => {
  test("renders data into HTML with document helpers available", async () => {
    const template = new PdfTemplate({
      html: "<p>{{currency amount}}</p><p>{{date when 'iso'}}</p>",
    });
    const html = await template.toHtml({ amount: 1_500_000, when: "2026-10-23" });
    expect(html).toContain("1.500.000");
    expect(html).toContain("2026-10-23");
  });

  test("injects design tokens as CSS variables", async () => {
    const template = new PdfTemplate(
      { html: "<p>x</p>" },
      { tokens: { brand: "#ff0000", "font-body": "Inter" } },
    );
    const html = await template.toHtml({});
    expect(html).toContain("--brand: #ff0000");
    expect(html).toContain("--font-body: Inter");
  });

  test("rejects unsafe token names instead of emitting broken CSS", async () => {
    const template = new PdfTemplate(
      { html: "<p>x</p>" },
      { tokens: { "bad name}body{color:red": "red", good: "1px" } },
    );
    const html = await template.toHtml({});
    expect(html).not.toContain("bad name");
    expect(html).toContain("--good: 1px");
  });

  test("registered helpers are usable immediately", async () => {
    const template = new PdfTemplate({ html: "{{shout w}}" })
      .helper("shout", (value) => `${String(value).toUpperCase()}!`);
    expect(await template.toHtml({ w: "hey" })).toBe("HEY!");
  });

  test("registered partials work", async () => {
    const template = new PdfTemplate({ html: "[{{> bit}}]" }).partial("bit", "{{v}}");
    expect(await template.toHtml({ v: 7 })).toBe("[7]");
  });

  test("produces a PDF", async () => {
    const template = new PdfTemplate({
      html: "<h1>{{title}}</h1><p>{{body}}</p>",
    });
    const result = await template.toPdf({ title: "Tiêu đề", body: "Nội dung" });
    expect(result.pageCount).toBe(1);
    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
  }, 60_000);
});

describe("loadTemplate: directory source", () => {
  test("loads entry, partials and layout from a directory", async () => {
    const dir = await tempDir();
    try {
      await Bun.write(
        join(dir, "index.html"),
        "<h1>{{title}}</h1>{{> body}}",
      );
      await Bun.write(join(dir, "body.partial.html"), "<p>{{text}}</p>");
      await Bun.write(join(dir, "layout.html"), "<html><body>{{{body}}}</body></html>");
      await Bun.write(join(dir, "style.css"), "h1 { color: rebeccapurple; }");
      await Bun.write(
        join(dir, "index.html"),
        '<html><head><link rel="stylesheet" href="./style.css"></head><body><h1>{{title}}</h1>{{> body}}</body></html>',
      );

      const template = await loadTemplate(dir);
      const html = await template.toHtml({ title: "T", text: "Nội dung" });

      expect(html).toContain("<h1>T</h1>");
      expect(html).toContain("<p>Nội dung</p>");

      // The stylesheet sits next to the template, so it must be found even
      // though the process cwd is somewhere else entirely.
      const result = await template.toPdf({ title: "T", text: "Nội dung" });
      expect(result.html).toContain("rebeccapurple");
      expect(result.pageCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("throws a clear error for a missing directory", async () => {
    await expect(loadTemplate("/tmp/definitely-not-a-template-xyz")).rejects.toThrow(
      /Template entry not found/,
    );
  });

  test("baseDir points at the template so relative assets resolve", async () => {
    const template = await loadTemplate(`${import.meta.dir}/../examples/invoice`);
    expect(template.baseDir.endsWith("examples/invoice")).toBe(true);
  });
});

describe("examples", () => {
  test("invoice example renders one page with real totals", async () => {
    const template = await loadTemplate(`${import.meta.dir}/../examples/invoice`);
    const data = (await Bun.file(`${import.meta.dir}/../examples/invoice/data.json`).json()) as any;

    const subtotal = data.items.reduce(
      (total: number, item: any) => total + item.quantity * item.unitPrice,
      0,
    );
    const vat = Math.round(((subtotal - data.totals.discount) * data.totals.vatRate) / 100);
    const grand = subtotal - data.totals.discount + vat;

    const result = await template.toPdf({
      ...data,
      totals: { ...data.totals, subtotal, vat, grand },
    });

    expect(subtotal).toBe(116_700_000);
    expect(grand).toBe(125_070_000);
    expect(result.pageCount).toBe(1);
    expect(result.html).toContain("125.070.000");
    expect(result.html).toContain("Một trăm hai mươi lăm triệu");
  }, 60_000);

  test("report example renders bars with real heights", async () => {
    const template = await loadTemplate(`${import.meta.dir}/../examples/report`);
    const html = await template.toHtml({
      title: "Báo cáo",
      subtitle: "sub",
      author: "a",
      generatedAt: "2026-10-23",
      series: [
        { label: "T1", value: 100, display: "100", height: 50, delta: null },
        { label: "T2", value: 200, display: "200", height: 100, delta: 12.5 },
      ],
      peak: 200,
      highlights: [],
      table: [],
    });
    expect(html).toContain('style="height: 50%"');
    expect(html).toContain('style="height: 100%"');
  });
});

describe("template safety", () => {
  test("template output is escaped so data cannot inject markup", async () => {
    const template = new PdfTemplate({ html: "<p>{{user}}</p>" });
    const html = await template.toHtml({ user: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("no eval: template expressions cannot reach globals", () => {
    expect(render("{{constructor}}", {})).toBe("");
    expect(render("{{process}}", {})).toBe("");
  });
});
