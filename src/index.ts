/**
 * pdf-service — Bun-native PDF generation.
 *
 * Two jobs, one engine:
 *   1. Render complex HTML/CSS to PDF (Chrome does the layout, so nothing is
 *      lost: flex, grid, `@page`, web fonts, SVG, gradients).
 *   2. Fill templates with data and print the result.
 *
 * Zero runtime dependencies: uses Bun's global WebSocket for CDP and the
 * Chrome already installed on the machine.
 */

export { launchBrowser, findBrowser } from "./browser/launcher.ts";
export type { BrowserSession, LaunchOptions, ResolvedBrowser, BrowserFlavor } from "./browser/launcher.ts";
export { CdpConnection, CdpError } from "./browser/cdp.ts";

export {
  renderHtmlToPdf,
  generatePdf,
  countPages,
  toInches,
  PAPER_SIZES,
  RenderError,
} from "./render/print.ts";
export type {
  PDFOptions,
  RenderOptions,
  RenderResult,
  PaperSize,
  PaperSizeName,
  MarginValue,
} from "./render/print.ts";

export { render, renderFile, escapeHtml, TemplateError } from "./template/engine.ts";
export type { TemplateData, TemplateOptions, Helper } from "./template/engine.ts";

export { PdfTemplate, loadTemplate } from "./template/document.ts";
export type { BuildOptions, LoadTemplateOptions, TemplateSource } from "./template/document.ts";

export {
  documentHelpers,
  formatCurrency,
  formatDate,
  formatNumber,
  numberToVietnameseWords,
  percentOf,
  slugify,
  sumBy,
  multiply,
} from "./template/helpers.ts";

export { inlineAssets } from "./assets/inline.ts";
export type { InlineOptions } from "./assets/inline.ts";

/** Library version, kept in sync with package.json manually (no fs read at import). */
export const VERSION = "0.1.0";
