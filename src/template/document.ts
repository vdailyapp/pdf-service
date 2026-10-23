/**
 * Template -> PDF layer.
 *
 * A `PdfTemplate` binds HTML/CSS (inline, file, or a directory of partials) to
 * a data source, then renders through the print pipeline. Design tokens are
 * passed as CSS custom properties so one stylesheet can serve many brands.
 */

import { render, renderFile, type Helper, type TemplateData, type TemplateOptions } from "./engine.ts";
import { documentHelpers } from "./helpers.ts";
import { renderHtmlToPdf, type RenderOptions, type RenderResult } from "../render/print.ts";

export type TemplateSource =
  | { html: string }
  | { path: string }
  | { dir: string; name?: string };

export type BuildOptions = {
  /** Render options forwarded to the PDF pipeline. */
  render?: RenderOptions;
  /** Named partials; `dir` sources also auto-load `*.partial.html`. */
  partials?: Record<string, string>;
  /** Template options (helpers, strict mode, layout). */
  template?: TemplateOptions;
  /** Design tokens injected as CSS variables. */
  tokens?: Record<string, string | number>;
};

const TOKEN_SAFE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

function tokensToCss(tokens: Record<string, string | number> = {}): string {
  const entries = Object.entries(tokens);
  if (entries.length === 0) return "";
  const declarations = entries
    .filter(([key]) => TOKEN_SAFE.test(key))
    .map(([key, value]) => `  --${key}: ${value};`)
    .join("\n");
  return `:root {\n${declarations}\n}`;
}

export class PdfTemplate {
  readonly #source: TemplateSource;
  readonly #options: BuildOptions;
  #html: string | null = null;
  #partials: Record<string, string> = {};
  #layout: string | undefined;
  #baseDir: string = process.cwd();

  constructor(source: TemplateSource, options: BuildOptions = {}) {
    this.#source = source;
    this.#options = options;
    this.#partials = { ...(options.partials ?? {}) };
    this.#layout = options.template?.layout;
  }

  /** Directory relative asset URLs resolve against (template location). */
  get baseDir(): string {
    return this.#baseDir;
  }

  /** Parse the template once; safe to call repeatedly. */
  async compile(): Promise<this> {
    if (this.#html !== null) return this;

    if ("html" in this.#source) {
      this.#html = this.#source.html;
    } else if ("path" in this.#source) {
      const file = Bun.file(this.#source.path);
      if (!(await file.exists())) {
        throw new Error(`Template file not found: ${this.#source.path}`);
      }
      this.#html = await file.text();
      this.#baseDir = absolute(this.#source.path).replace(/\/[^/]*$/, "") || "/";
    } else {
      const dir = this.#source.dir.replace(/\/$/, "");
      const name = this.#source.name ?? "index.html";
      const entry = Bun.file(`${dir}/${name}`);
      if (!(await entry.exists())) {
        throw new Error(`Template entry not found: ${dir}/${name}`);
      }
      this.#html = await entry.text();
      this.#baseDir = dir;

      const glob = new Bun.Glob("*.partial.html");
      for await (const relative of glob.scan({ cwd: dir, absolute: true })) {
        const key = relative
          .slice(relative.lastIndexOf("/") + 1)
          .replace(/\.partial\.html$/, "");
        this.#partials[key] = await Bun.file(relative).text();
      }

      const layoutFile = Bun.file(`${dir}/layout.html`);
      if (!this.#layout && (await layoutFile.exists())) {
        this.#layout = await layoutFile.text();
      }
    }

    return this;
  }

  /** Raw HTML source, before data is applied. */
  async source(): Promise<string> {
    await this.compile();
    return this.#html!;
  }

  /** Render the template with data into a complete HTML string. */
  async toHtml(data: TemplateData = {}): Promise<string> {
    await this.compile();

    let html = render(this.#html!, data, {
      // Document helpers (currency/date/words/…) are always available: templates
      // are for documents, and making callers import them every time is noise.
      helpers: { ...documentHelpers, ...(this.#options.template?.helpers ?? {}) },
      partials: { ...this.#partials, ...(this.#options.template?.partials ?? {}) },
      layout: this.#layout,
      escape: this.#options.template?.escape,
      strict: this.#options.template?.strict,
    });

    const css = tokensToCss(this.#options.tokens);
    if (css) html = injectCss(html, css);
    return html;
  }

  /** Render the template and print it to PDF bytes. */
  async toPdf(data: TemplateData = {}, renderOptions: RenderOptions = {}): Promise<RenderResult> {
    const html = await this.toHtml(data);
    return renderHtmlToPdf(html, {
      ...this.#options.render,
      ...renderOptions,
      // Relative CSS/images resolve against the template, not the cwd.
      inlineAssets:
        renderOptions.inlineAssets ?? this.#options.render?.inlineAssets ?? { baseDir: this.#baseDir },
    });
  }

  /** Register a helper after construction. */
  helper(name: string, fn: Helper): this {
    this.#options.template = this.#options.template ?? {};
    this.#options.template.helpers = { ...(this.#options.template.helpers ?? {}), [name]: fn };
    return this;
  }

  /** Register a partial after construction. */
  partial(name: string, html: string): this {
    this.#partials[name] = html;
    return this;
  }
}

/** Absolute path without resolving through the cwd twice. */
function absolute(path: string): string {
  return path.startsWith("/") ? path : `${process.cwd()}/${path}`;
}

function injectCss(html: string, css: string): string {
  const block = `<style data-pdfsmith-tokens>${css}</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${block}</head>`);
  if (/<html([^>]*)>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${block}</head>`);
  return block + html;
}

export type LoadTemplateOptions = BuildOptions & {
  /** Entry filename inside a template directory. Default `index.html`. */
  name?: string;
};

/**
 * Load a template from a file or directory.
 *
 * ```ts
 * const invoice = await loadTemplate("./templates/invoice");
 * const { bytes } = await invoice.toPdf(data);
 * ```
 */
export async function loadTemplate(
  target: string,
  options: LoadTemplateOptions = {},
): Promise<PdfTemplate> {
  if (await Bun.file(target).exists()) {
    return await new PdfTemplate({ path: target }, options).compile();
  }

  const dir = target.replace(/\/$/, "");
  return await new PdfTemplate({ dir, name: options.name ?? "index.html" }, options).compile();
}

export { render, renderFile };
export type { Helper, TemplateData, TemplateOptions };
