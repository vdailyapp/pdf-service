/**
 * Integration tests — these launch a real Chrome and inspect real PDF output.
 * They are the only tests that can catch the failures that actually matter:
 * blank pages, missing fonts, un-inlined CSS, wrong page counts.
 */

import { describe, expect, test } from "bun:test";
import { countPages, renderHtmlToPdf, toInches } from "../src/render/print.ts";

describe("print pipeline", () => {
  test("produces a valid PDF from trivial HTML", async () => {
    const { bytes, pageCount } = await renderHtmlToPdf("<h1>Hello</h1>", { format: "A4" });
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
    expect(pageCount).toBe(1);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  }, 60_000);

  test("renders the correct page size for each format", async () => {
    for (const [format, expected] of [
      ["A4", 595.92],
      ["Letter", 612],
    ] as const) {
      const { bytes } = await renderHtmlToPdf("<p>page</p>", { format });
      const text = new TextDecoder("latin1").decode(bytes);
      const match = /MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(text);
      expect(match).not.toBeNull();
      expect(Math.round(Number(match![1]))).toBe(Math.round(expected));
    }
  }, 60_000);

  test("landscape swaps width and height", async () => {
    const { bytes } = await renderHtmlToPdf("<p>wide</p>", { format: "A4", landscape: true });
    const text = new TextDecoder("latin1").decode(bytes);
    const match = /MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/.exec(text);
    expect(Number(match![1])).toBeGreaterThan(Number(match![2]));
  }, 60_000);

  test("long content paginates", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => `<p>Dòng ${i + 1} — nội dung kiểm tra</p>`).join("");
    const { pageCount } = await renderHtmlToPdf(rows, { format: "A4" });
    expect(pageCount).toBeGreaterThan(1);
  }, 60_000);

  test("pageRanges limits output pages", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => `<p>Dòng ${i + 1}</p>`).join("");
    const full = await renderHtmlToPdf(rows, { format: "A4" });
    const limited = await renderHtmlToPdf(rows, { format: "A4", pageRanges: "1" });
    expect(full.pageCount).toBeGreaterThan(1);
    expect(limited.pageCount).toBe(1);
  }, 60_000);

  test("waits for a selector before printing", async () => {
    const html = `
      <div id="root">loading</div>
      <script>
        setTimeout(() => { document.getElementById("root").textContent = "READY"; }, 300);
      </script>`;
    const { bytes } = await renderHtmlToPdf(html, {
      waitForFunction: `() => document.getElementById("root").textContent === "READY"`,
    });
    expect(bytes.byteLength).toBeGreaterThan(500);
  }, 60_000);

  test("times out with an actionable error when the selector never appears", async () => {
    await expect(
      renderHtmlToPdf("<div>nothing</div>", { waitForSelector: "#nope", timeoutMs: 1200 }),
    ).rejects.toThrow(/Timed out waiting for selector #nope/);
  }, 60_000);

  test("inlines a local stylesheet", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/pdf-service-test-${Date.now()}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    await Bun.write(`${dir}/style.css`, "body { background: #ff0000; } .marker { color: #00ff00; }");
    await Bun.write(
      `${dir}/page.html`,
      `<html><head><link rel="stylesheet" href="./style.css"></head><body><p class="marker">X</p></body></html>`,
    );

    const html = await Bun.file(`${dir}/page.html`).text();
    const { html: composed } = await renderHtmlToPdf(html, {
      inlineAssets: { baseDir: dir },
    });

    expect(composed).toContain("background: #ff0000");
    expect(composed).not.toContain('rel="stylesheet"');
    await Bun.$`rm -rf ${dir}`.quiet();
  }, 60_000);

  test("watermark does not add pages", async () => {
    const plain = await renderHtmlToPdf("<p>one page</p>");
    const marked = await renderHtmlToPdf("<p>one page</p>", { watermark: "BẢN NHÁP" });
    expect(plain.pageCount).toBe(1);
    expect(marked.pageCount).toBe(1);
    expect(marked.bytes.byteLength).toBeGreaterThan(plain.bytes.byteLength);
  }, 60_000);

  test("header and footer do not overlap content", async () => {
    const { pageCount } = await renderHtmlToPdf("<h1>Body</h1><p>text</p>", {
      header: '<div style="font-size:8px">Header</div>',
      footer: '<div style="font-size:8px">Page <span class="pageNumber"></span></div>',
    });
    expect(pageCount).toBe(1);
  }, 60_000);

  test("reports timings", async () => {
    const { timings } = await renderHtmlToPdf("<p>timed</p>");
    expect(timings.totalMs).toBeGreaterThan(0);
    expect(timings.printMs).toBeGreaterThan(0);
  }, 60_000);
});

describe("units", () => {
  test("toInches converts CSS units", () => {
    expect(toInches("1in")).toBeCloseTo(1, 5);
    expect(toInches("25.4mm")).toBeCloseTo(1, 5);
    expect(toInches("2.54cm")).toBeCloseTo(1, 5);
    expect(toInches("72pt")).toBeCloseTo(1, 5);
    expect(toInches("96px")).toBeCloseTo(1, 5);
    expect(toInches(0.5)).toBe(0.5);
    expect(toInches(undefined, 0.3)).toBe(0.3);
  });

  test("toInches rejects nonsense", () => {
    expect(() => toInches("banana")).toThrow(/Invalid margin/);
    expect(() => toInches(-1)).toThrow(/Invalid margin/);
  });

  test("countPages reads Chrome output", async () => {
    const { bytes, pageCount } = await renderHtmlToPdf(
      Array.from({ length: 90 }, (_, i) => `<p>row ${i}</p>`).join(""),
    );
    expect(countPages(bytes)).toBe(pageCount);
  }, 60_000);
});
