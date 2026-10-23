#!/usr/bin/env bun
/**
 * pdfsmith CLI
 *
 *   pdfsmith render invoice.html -o invoice.pdf --format A4
 *   pdfsmith fill templates/invoice -d data.json -o out/invoice.pdf
 *   pdfsmith doctor
 */

import { parseArgs } from "node:util";
import { renderHtmlToPdf, PAPER_SIZES, type PaperSizeName, type RenderOptions } from "./render/print.ts";
import { loadTemplate } from "./template/document.ts";
import { documentHelpers } from "./template/helpers.ts";
import { findBrowser, launchBrowser } from "./browser/launcher.ts";
import { VERSION } from "./index.ts";

const HELP = `pdfsmith ${VERSION} — Bun-native HTML/CSS → PDF

USAGE
  pdfsmith render <file.html|-> [options]     Render HTML to PDF
  pdfsmith fill <template dir|file> [options]  Fill a template with data, then print
  pdfsmith doctor                              Check the browser toolchain

OPTIONS
  -d, --data <file.json>      JSON data for template filling ("-" reads stdin)
  -o, --output <path>         Output PDF path (default: derived from input)
      --format <name>         ${Object.keys(PAPER_SIZES).join(" | ")} (default A4)
      --landscape             Landscape orientation
      --margin <value>        Margin in inches or CSS units, e.g. 0.5 or 12mm
      --scale <n>             Print scale 0.1–2 (default 1)
      --no-background         Do not print background colors/images
      --page-ranges <ranges>  e.g. "1-3,5"
      --header <html>         Running header HTML
      --footer <html>         Running footer HTML
      --watermark <text>      Diagonal watermark text
      --css <file>            Extra CSS file appended to the document
      --title <text>          PDF metadata title
      --wait-for <selector>   Wait for a CSS selector before printing
      --no-inline             Do not inline local assets
      --headful               Show the browser window
      --keep-html             Write the intermediate HTML next to the output
  -h, --help                  Show this help
  -v, --version               Print version
`;

function fail(message: string): never {
  console.error(`pdfsmith: ${message}`);
  process.exit(1);
}

async function readJson(path?: string): Promise<Record<string, unknown>> {
  if (!path) return {};
  const text = path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail("Data must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`Invalid JSON in ${path === "-" ? "stdin" : path}: ${(error as Error).message}`);
  }
}

async function readHtml(input: string): Promise<{ html: string; baseDir: string; stem: string }> {
  if (input === "-") {
    const html = await Bun.stdin.text();
    if (!html.trim()) fail("No HTML received on stdin");
    return { html, baseDir: process.cwd(), stem: "stdin" };
  }
  const file = Bun.file(input);
  if (!(await file.exists())) fail(`File not found: ${input}`);
  const absolute = input.startsWith("/") ? input : `${process.cwd()}/${input}`;
  const slash = absolute.lastIndexOf("/");
  return {
    html: await file.text(),
    baseDir: absolute.slice(0, slash) || "/",
    stem: absolute.slice(slash + 1).replace(/\.(html?|mjml)$/i, ""),
  };
}

function outputPath(path: string | undefined, stem: string, dir?: string): string {
  if (path) return path;
  return `${dir ?? process.cwd()}/${stem}.pdf`;
}

async function writeOutput(path: string, bytes: Uint8Array): Promise<void> {
  await Bun.write(path, bytes);
}

function baseRenderOptions(values: Record<string, unknown>): RenderOptions {
  const format = values.format as string | undefined;
  if (format && !(format in PAPER_SIZES)) {
    fail(`Unknown --format "${format}". Options: ${Object.keys(PAPER_SIZES).join(", ")}`);
  }

  const options: RenderOptions = {
    format: (format as PaperSizeName) ?? "A4",
    landscape: values.landscape === true,
    printBackground: values.background !== false,
    margin: values.margin as string | undefined,
    scale: values.scale ? Number(values.scale) : undefined,
    pageRanges: values["page-ranges"] as string | undefined,
    header: values.header as string | undefined,
    footer: values.footer as string | undefined,
    watermark: values.watermark as string | undefined,
    title: values.title as string | undefined,
    waitForSelector: values["wait-for"] as string | undefined,
    inlineAssets: values.inline === false ? false : undefined,
    launch: { headless: values.headful !== true },
  };

  return options;
}

async function renderCommand(input: string, values: Record<string, unknown>): Promise<void> {
  const { html, baseDir, stem } = await readHtml(input);
  const options = baseRenderOptions(values);

  if (values.css) {
    const path = values.css as string;
    const file = Bun.file(path);
    if (!(await file.exists())) fail(`CSS file not found: ${path}`);
    options.css = await file.text();
  }

  const output = outputPath(values.output as string | undefined, stem);

  const started = Date.now();
  const result = await renderHtmlToPdf(html, {
    ...options,
    inlineAssets: options.inlineAssets === false ? false : { baseDir },
  });

  await writeOutput(output, result.bytes);
  if (values["keep-html"]) {
    await Bun.write(output.replace(/\.pdf$/i, "") + ".html", result.html);
  }

  report(output, result, Date.now() - started);
}

async function fillCommand(input: string, values: Record<string, unknown>): Promise<void> {
  const data = await readJson(values.data as string | undefined);
  const options = baseRenderOptions(values);

  if (values.css) {
    const file = Bun.file(values.css as string);
    if (!(await file.exists())) fail(`CSS file not found: ${values.css}`);
    options.css = await file.text();
  }

  const template = await loadTemplate(input, {
    template: { helpers: documentHelpers },
  });

  // The template knows where it lives; recomputing the base dir here is how
  // relative stylesheets silently stop being inlined.
  const baseDir = template.baseDir;

  const stem = input.replace(/\/$/, "").split("/").pop() ?? "document";
  const output = outputPath(values.output as string | undefined, stem);

  const started = Date.now();
  const result = await template.toPdf(data, {
    ...options,
    inlineAssets: options.inlineAssets === false ? false : { baseDir },
  });

  await writeOutput(output, result.bytes);
  if (values["keep-html"]) {
    await Bun.write(output.replace(/\.pdf$/i, "") + ".html", result.html);
  }

  report(output, result, Date.now() - started);
}

function report(output: string, result: { pageCount: number; bytes: Uint8Array; timings: { totalMs: number } }, elapsed: number): void {
  const kb = (result.bytes.byteLength / 1024).toFixed(1);
  console.log(
    `✔ ${output}  ${result.pageCount} page${result.pageCount === 1 ? "" : "s"}  ${kb} KB  ${elapsed}ms`,
  );
}

async function doctorCommand(): Promise<void> {
  const found = await findBrowser();
  if (!found) {
    console.error("✖ No Chrome/Chromium found.");
    console.error("  macOS: install Google Chrome, or set PDFSMITH_CHROME_PATH.");
    console.error("  CI:    bunx playwright install chromium");
    process.exit(1);
  }

  console.log(`✔ Browser   ${found.flavor} — ${found.version}`);
  console.log(`  Path      ${found.path}`);
  console.log(`✔ Bun       ${Bun.version}`);

  const started = Date.now();
  const session = await launchBrowser({ executablePath: found.path });
  try {
    const { bytes } = await renderHtmlToPdf("<h1>ok</h1>", { browser: session });
    console.log(`✔ Print     ${bytes.byteLength} bytes in ${Date.now() - started}ms`);
    console.log("✔ Ready");
  } finally {
    await session.close();
  }
}

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
if (argv.includes("-v") || argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const command = argv[0];
const rest = argv.slice(1);

const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    data: { type: "string", short: "d" },
    output: { type: "string", short: "o" },
    format: { type: "string" },
    landscape: { type: "boolean" },
    margin: { type: "string" },
    scale: { type: "string" },
    background: { type: "boolean" },
    "no-background": { type: "boolean" },
    "page-ranges": { type: "string" },
    header: { type: "string" },
    footer: { type: "string" },
    watermark: { type: "string" },
    css: { type: "string" },
    title: { type: "string" },
    "wait-for": { type: "string" },
    inline: { type: "boolean" },
    "no-inline": { type: "boolean" },
    headful: { type: "boolean" },
    "keep-html": { type: "boolean" },
  },
});

const normalized: Record<string, unknown> = { ...values };
if (values["no-background"]) normalized.background = false;
if (values["no-inline"]) normalized.inline = false;

try {
  switch (command) {
    case "render": {
      const input = positionals[0] ?? "-";
      await renderCommand(input, normalized);
      break;
    }
    case "fill": {
      const input = positionals[0];
      if (!input) fail("fill requires a template path");
      await fillCommand(input, normalized);
      break;
    }
    case "doctor":
      await doctorCommand();
      break;
    default:
      fail(`Unknown command "${command}". Try: render, fill, doctor`);
  }
} catch (error) {
  fail((error as Error).message);
}

export {};
