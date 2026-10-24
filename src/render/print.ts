/**
 * The print pipeline: HTML string -> Chrome -> PDF bytes.
 *
 * All layout is delegated to Blink, so anything Chrome can print (flex, grid,
 * `@page`, `break-inside`, web fonts, gradients, SVG) works here unchanged.
 * What we add on top is the operational layer: deterministic waiting, asset
 * inlining, headers/footers, watermarks, page ranges and strict resource
 * cleanup.
 */

import { CdpConnection, CdpError } from "../browser/cdp.ts";
import { launchBrowser, type BrowserSession, type LaunchOptions } from "../browser/launcher.ts";
import { inlineAssets, type InlineOptions } from "../assets/inline.ts";

export const PAPER_SIZES = {
  A0: [33.11, 46.81],
  A1: [23.39, 33.11],
  A2: [16.54, 23.39],
  A3: [11.69, 16.54],
  A4: [8.27, 11.69],
  A5: [5.83, 8.27],
  A6: [4.13, 5.83],
  Letter: [8.5, 11],
  Legal: [8.5, 14],
  Tabloid: [11, 17],
  Ledger: [17, 11],
  Executive: [7.25, 10.5],
} as const;

export type PaperSizeName = keyof typeof PAPER_SIZES;
export type PaperSize = PaperSizeName | [number, number] | { width: number; height: number };

export type MarginValue = number | string;

export type PDFOptions = {
  /** Paper size name (A4, Letter, …) or explicit inches. Default "A4". */
  format?: PaperSize;
  landscape?: boolean;
  /** Print background colors/images. Default true. */
  printBackground?: boolean;
  /** Render scale, 0.1 – 2. Default 1. */
  scale?: number;
  /** Margins in inches (number) or CSS units ("12mm"). Default 0. */
  margin?:
    | MarginValue
    | { top?: MarginValue; right?: MarginValue; bottom?: MarginValue; left?: MarginValue };
  /** Let `@page { size: … }` in CSS win over `format`. Default true. */
  preferCSSPageSize?: boolean;
  /** "1-3,5" style ranges. */
  pageRanges?: string;
  /** HTML for the running header. Supports pageNumber/totalPages classes. */
  header?: string;
  /** HTML for the running footer. */
  footer?: string;
  /** Distance from paper edge to header/footer, in inches or CSS units. */
  headerFooterMargin?: MarginValue;
  /** Stamp text across every page. */
  watermark?: string | { text: string; color?: string; opacity?: number; fontSize?: string; angle?: number };
  /** Extra CSS appended after the document's own styles. */
  css?: string;
  /** Emulate a print stylesheet in addition to the print pipeline. Default true. */
  mediaType?: "print" | "screen";
  /** Add outline (PDF bookmarks) from headings. Default true. */
  outline?: boolean;
  /** Tagged PDF for accessibility. Default false (larger files). */
  tagged?: boolean;
  /** Document title, written into the PDF metadata. */
  title?: string;
  /** Wait for this CSS selector to exist before printing. */
  waitForSelector?: string;
  /** Wait until `window.__ready === true` (or the returned promise resolves). */
  waitForFunction?: string;
  /** Extra settle time in ms after load. Default 0. */
  waitAfterLoad?: number;
  /** Navigate timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Inline local assets (css/img/fonts) before printing. Default true. */
  inlineAssets?: boolean | InlineOptions;
  /**
   * Restrict what the page may load: `data:` URLs always pass, plus these origins
   * (e.g. "https://fonts.gstatic.com"); everything else, `file://` included, is blocked.
   * Unset = no restriction. Set it (even to `[]`) for untrusted HTML.
   */
  allowedOrigins?: string[];
  /** Run page scripts. Default true; turn off for untrusted HTML. */
  javascript?: boolean;
  /** Keep the generated HTML (useful for debugging). */
  keepHtml?: boolean;
};

export type RenderResult = {
  bytes: Uint8Array;
  pageCount: number;
  html: string;
  timings: { launchMs: number; loadMs: number; printMs: number; totalMs: number };
};

export type RenderOptions = PDFOptions & {
  /** Reuse a browser across renders (recommended for batch work). */
  browser?: BrowserSession;
  /** Browser launch overrides when `browser` is not supplied. */
  launch?: LaunchOptions & { executablePath?: string };
};

/* --------------------------------------------------------------- utilities */

const CSS_UNITS = /^\d*\.?\d+(px|pt|pc|in|cm|mm|q|em|rem|%)$/i;

export function toInches(value: MarginValue | undefined, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid margin: ${value}`);
    return value;
  }
  const text = value.trim();
  const match = /^(-?\d*\.?\d+)\s*(px|pt|pc|in|cm|mm|q|em|rem)?$/i.exec(text);
  if (!match) throw new Error(`Invalid margin "${value}". Use inches (0.5) or a CSS unit ("12mm").`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "in").toLowerCase();
  const perInch: Record<string, number> = {
    in: 1,
    pt: 1 / 72,
    pc: 1 / 6,
    px: 1 / 96,
    cm: 1 / 2.54,
    mm: 1 / 25.4,
    q: 1 / 101.6,
    em: 1 / 6,
    rem: 1 / 6,
  };
  return amount * (perInch[unit] ?? 1);
}

function normalizePaper(size: PDFOptions["format"]): [number, number] {
  if (!size) return [...PAPER_SIZES.A4] as [number, number];
  if (Array.isArray(size)) {
    if (size.length !== 2 || !size.every((n) => Number.isFinite(n) && n > 0)) {
      throw new Error(`Invalid paper size: ${JSON.stringify(size)}`);
    }
    return [size[0]!, size[1]!];
  }
  if (typeof size === "object") {
    return [size.width, size.height];
  }
  const named = PAPER_SIZES[size as PaperSizeName];
  if (!named) {
    throw new Error(
      `Unknown paper size "${size}". Use one of: ${Object.keys(PAPER_SIZES).join(", ")}`,
    );
  }
  return [named[0], named[1]];
}

/**
 * Count pages in Chrome-produced PDFs.
 *
 * Chrome writes page objects uncompressed with an independent object stream, so
 * counting `/Type /Page` (excluding `/Pages`) is reliable for its output. For
 * PDFs that use object streams this falls back to a coarse estimate of 0.
 */
export function countPages(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  if (matches && matches.length > 0) return matches.length;
  const treeCount = /\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/.exec(text);
  return treeCount ? Number(treeCount[1]) : 0;
}

function watermarkCss(watermark: NonNullable<PDFOptions["watermark"]>): string {
  const config = typeof watermark === "string" ? { text: watermark } : watermark;
  const color = config.color ?? "#000000";
  const opacity = config.opacity ?? 0.08;
  const fontSize = config.fontSize ?? "96pt";
  const angle = config.angle ?? -30;
  const label = config.text.replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`);

  return `
@media print {
  html { --pdf-service-wm-color: ${color}; }
  body::after {
    content: "${label.replace(/"/g, '\\"')}";
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    font: 700 ${fontSize}/1 "Helvetica Neue", Arial, sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--pdf-service-wm-color);
    opacity: ${opacity};
    transform: rotate(${angle}deg);
    pointer-events: none;
    z-index: 2147483647;
    white-space: nowrap;
  }
}`;
}

const PRINT_RESET_CSS = `
@media print {
  *, *::before, *::after { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; }
  img, svg, canvas, table, tr { break-inside: avoid-page; }
  h1, h2, h3, h4 { break-after: avoid-page; }
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  a[href]::after { content: ""; }
}`;

/* ------------------------------------------------------------------ engine */

class RenderError extends Error {
  constructor(message: string, readonly stage: "load" | "print" | "browser" | "html") {
    super(message);
    this.name = "RenderError";
  }
}

export async function renderHtmlToPdf(html: string, options: RenderOptions = {}): Promise<RenderResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const ownsBrowser = !options.browser;
  const launchMs = { value: 0 };
  let browser = options.browser;
  let sessionId: string | null = null;
  let targetId: string | null = null;
  let stopGuard: (() => void) | undefined;

  try {
    if (!browser) {
      const launchStart = Date.now();
      browser = await launchBrowser(options.launch ?? {});
      launchMs.value = Date.now() - launchStart;
    }

    const page = await browser.newPage();
    sessionId = page.sessionId;
    targetId = page.targetId;

    const connection = browser.connection;

    let allowed: Set<string> | undefined;
    if (options.allowedOrigins) {
      const guard = await guardRequests(connection, sessionId, options.allowedOrigins);
      allowed = guard.documents;
      stopGuard = guard.stop;
    }

    const prepared = options.inlineAssets === false
      ? html
      : await inlineAssets(
          html,
          typeof options.inlineAssets === "object"
            ? options.inlineAssets
            : { baseDir: process.cwd() },
        ).catch(() => html);

    const composed = composeDocument(prepared, options);
    const document = options.javascript === false ? blockScripts(composed) : composed;
    const loadStart = Date.now();

    await navigate(connection, sessionId, document, timeoutMs, allowed);

    if (options.mediaType) {
      await connection
        .send("Emulation.setEmulatedMedia", { media: options.mediaType }, sessionId)
        .catch(() => {});
    }

    await settle(connection, sessionId, options, timeoutMs);
    const loadMs = Date.now() - loadStart;

    const printStart = Date.now();
    const bytes = await print(connection, sessionId, options);
    const printMs = Date.now() - printStart;

    return {
      bytes,
      pageCount: countPages(bytes),
      html: document,
      timings: {
        launchMs: launchMs.value,
        loadMs,
        printMs,
        totalMs: Date.now() - started,
      },
    };
  } catch (error) {
    if (error instanceof CdpError) {
      throw new RenderError(`Chrome rejected ${error.method}: ${error.message}`, "print");
    }
    if (error instanceof RenderError) throw error;
    throw new RenderError(error instanceof Error ? error.message : String(error), "browser");
  } finally {
    stopGuard?.();
    if (browser && sessionId) {
      await browser.connection
        .send("Target.closeTarget", { targetId: targetId ?? sessionId })
        .catch(() => {});
    }
    if (browser && ownsBrowser) await browser.close();
  }
}

/**
 * Disable page scripts with a CSP placed before any markup the caller controls.
 * (`Emulation.setScriptExecutionDisabled` would also stall our own Runtime.evaluate
 * probes; CSP does not apply to DevTools.) Right after the doctype, the meta opens
 * <head> itself, so a <script> ahead of the caller's <head> is still covered, and
 * the document stays in standards mode.
 */
function blockScripts(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`;
  return html.replace(/^(\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>)?)/i, `$1${csp}`);
}

function composeDocument(html: string, options: PDFOptions): string {
  // If the caller handed us a full document, inject before </head>.
  const css = [PRINT_RESET_CSS, options.css ?? "", options.watermark ? watermarkCss(options.watermark) : ""]
    .filter(Boolean)
    .join("\n");

  const title = options.title ? `<title>${options.title.replace(/[<>&]/g, "")}</title>` : "";

  if (/<html[\s>]/i.test(html)) {
    let output = html;
    if (title && !/<title[\s>]/i.test(output)) {
      output = output.replace(/<head([^>]*)>/i, `<head$1>${title}`);
    }
    if (/<\/head>/i.test(output)) {
      return output.replace(/<\/head>/i, `<style data-pdf-service>${css}</style></head>`);
    }
    return output.replace(/<html([^>]*)>/i, `<html$1><head><style data-pdf-service>${css}</style></head>`);
  }

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    title,
    `<style data-pdf-service>${css}</style>`,
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

async function navigate(
  connection: CdpConnection,
  sessionId: string,
  html: string,
  timeoutMs: number,
  allowed?: Set<string>,
): Promise<void> {
  const base64 = Buffer.from(html, "utf8").toString("base64");
  // data: URLs keep the document same-origin-ish and avoid a temp file, but
  // they cap out around 2 MB in Chrome; fall back to a blob-free file URL then.
  if (base64.length < 1_800_000) {
    const url = `data:text/html;charset=utf-8;base64,${base64}`;
    const loaded = connection.once("Page.loadEventFired", sessionId, timeoutMs);
    await connection.send("Page.navigate", { url }, sessionId);
    await loaded.catch(() => {
      /* not fatal: we still probe the DOM below */
    });
    return;
  }

  const path = `${process.env.TMPDIR ?? "/tmp"}/pdf-service-${Date.now()}-${Math.random().toString(36).slice(2)}.html`;
  await Bun.write(path, html);
  // Under a request guard only this exact file may load, not its neighbours in TMPDIR.
  allowed?.add(`file://${path}`);
  try {
    const loaded = connection.once("Page.loadEventFired", sessionId, timeoutMs);
    await connection.send("Page.navigate", { url: `file://${path}` }, sessionId);
    await loaded.catch(() => {});
  } finally {
    // The page has parsed the file by now; leaving it would leak temp files.
    setTimeout(() => void Bun.$`rm -f ${path}`.quiet().catch(() => {}), 5_000);
  }
}

/**
 * Pause every request of the page and let through only `data:`, the documents we
 * navigate to, and `origins`. Returns the document allow-list and an unsubscribe.
 */
async function guardRequests(
  connection: CdpConnection,
  sessionId: string,
  origins: string[],
): Promise<{ documents: Set<string>; stop: () => void }> {
  const documents = new Set<string>();
  const allowedOrigins = new Set(origins.map((origin) => new URL(origin).origin));
  const stop = connection.on("Fetch.requestPaused", (event) => {
    if (event.sessionId !== sessionId) return;
    const { requestId, request } = event.params as { requestId: string; request: { url: string } };
    const url = request.url;
    let pass = url.startsWith("data:") || documents.has(url);
    if (!pass && /^https?:/i.test(url)) {
      try {
        pass = allowedOrigins.has(new URL(url).origin);
      } catch {
        pass = false;
      }
    }
    const reply = pass
      ? connection.send("Fetch.continueRequest", { requestId }, sessionId)
      : connection.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId);
    reply.catch(() => {});
  });
  await connection.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
  return { documents, stop };
}

async function settle(
  connection: CdpConnection,
  sessionId: string,
  options: PDFOptions,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  if (options.waitForSelector) {
    const selector = JSON.stringify(options.waitForSelector);
    await pollEvaluate(
      connection,
      sessionId,
      `!!document.querySelector(${selector})`,
      deadline,
      `selector ${options.waitForSelector}`,
    );
  }

  if (options.waitForFunction) {
    await pollEvaluate(connection, sessionId, `(${options.waitForFunction})`, deadline, "waitForFunction");
  }

  // Fonts + images are the two things that silently produce blank pages.
  await pollEvaluate(
    connection,
    sessionId,
    `(async () => {
      if (document.fonts && document.fonts.status !== "loaded") await document.fonts.ready;
      await Promise.all([...document.images].map((img) =>
        img.complete ? Promise.resolve() : new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        })
      ));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return true;
    })()`,
    deadline,
    "fonts and images",
  );

  if (options.waitAfterLoad && options.waitAfterLoad > 0) {
    await Bun.sleep(options.waitAfterLoad);
  }
}

async function pollEvaluate(
  connection: CdpConnection,
  sessionId: string,
  expression: string,
  deadline: number,
  label: string,
): Promise<void> {
  while (Date.now() < deadline) {
    const { result } = await connection.send<{
      result: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string };
    }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );

    if (result?.value !== undefined && result.value !== false) return;
    await Bun.sleep(50);
  }
  throw new RenderError(`Timed out waiting for ${label}`, "load");
}

async function print(
  connection: CdpConnection,
  sessionId: string,
  options: PDFOptions,
): Promise<Uint8Array> {
  const [width, height] = normalizePaper(options.format);

  const margin = options.margin ?? 0;
  const explicit = typeof margin === "object" && margin !== null;
  const headerFooterMargin = toInches(options.headerFooterMargin, 0.3);

  const margins = explicit
    ? {
        top: toInches((margin as any).top, 0),
        right: toInches((margin as any).right, 0),
        bottom: toInches((margin as any).bottom, 0),
        left: toInches((margin as any).left, 0),
      }
    : (() => {
        const all = toInches(margin as MarginValue, 0);
        return { top: all, right: all, bottom: all, left: all };
      })();

  // Chrome needs room for header/footer templates or they overlap content.
  if (options.header) margins.top = Math.max(margins.top, headerFooterMargin + 0.15);
  if (options.footer) margins.bottom = Math.max(margins.bottom, headerFooterMargin + 0.15);

  const params: Record<string, unknown> = {
    printBackground: options.printBackground !== false,
    scale: clamp(options.scale ?? 1, 0.1, 2),
    // Chrome applies the orientation itself, so dimensions stay portrait here.
    // Swapping them too would rotate twice and print portrait.
    paperWidth: width,
    paperHeight: height,
    landscape: options.landscape === true,
    displayHeaderFooter: Boolean(options.header || options.footer),
    headerTemplate: options.header ?? "<div></div>",
    footerTemplate: options.footer ?? "<div></div>",
    marginTop: margins.top,
    marginBottom: margins.bottom,
    marginLeft: margins.left,
    marginRight: margins.right,
    preferCSSPageSize: options.preferCSSPageSize !== false,
    transferMode: "ReturnAsBase64",
    generateTaggedPDF: options.tagged === true,
    generateDocumentOutline: options.outline !== false,
  };

  if (options.pageRanges) params.pageRanges = options.pageRanges;

  const { data } = await connection.send<{ data: string }>("Page.printToPDF", params, sessionId);
  if (!data) throw new RenderError("Chrome returned an empty PDF", "print");
  return Uint8Array.from(Buffer.from(data, "base64"));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Convenience: one-shot browser, one document, cleaned up afterwards. */
export async function generatePdf(html: string, options: RenderOptions = {}): Promise<Uint8Array> {
  return (await renderHtmlToPdf(html, options)).bytes;
}

export { RenderError };
