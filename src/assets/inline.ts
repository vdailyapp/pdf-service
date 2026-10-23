/**
 * Asset inlining.
 *
 * A PDF renderer that needs a running HTTP server is a bad library. Instead we
 * rewrite relative URLs in the HTML so the page is self-contained: local CSS,
 * local images, and local fonts all become inline data or absolute file URLs.
 * Remote http(s) URLs are left alone (Chrome fetches them, which is what you
 * want for CDN fonts).
 */

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".css": "text/css",
  ".json": "application/json",
};

export type InlineOptions = {
  /** Base directory for resolving relative paths. Defaults to cwd. */
  baseDir?: string;
  /** Skip inlining entries larger than this (bytes). Default 12 MiB. */
  maxBytes?: number;
  /** Inline <link rel=stylesheet> and <script src> too. Default true for CSS only. */
  inlineStyles?: boolean;
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

async function toDataUri(path: string, maxBytes: number): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  if (file.size > maxBytes) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return `data:${mimeFor(path)};base64,${Buffer.from(bytes).toString("base64")}`;
}

function resolveUrl(url: string, baseDir: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^(data:|https?:|blob:|#|mailto:)/i.test(trimmed)) return null;
  if (trimmed.startsWith("file://")) return decodeURIComponent(trimmed.slice("file://".length));
  if (trimmed.startsWith("/")) return trimmed; // absolute filesystem path
  return `${baseDir.replace(/\/$/, "")}/${trimmed.replace(/^\.\//, "")}`;
}

/** Rewrite relative asset URLs in an HTML string to embedded data URIs. */
export async function inlineAssets(html: string, options: InlineOptions = {}): Promise<string> {
  const baseDir = options.baseDir ?? process.cwd();
  const maxBytes = options.maxBytes ?? 12 * 1024 * 1024;
  const inlineStyles = options.inlineStyles !== false;

  let output = html;

  // <link rel="stylesheet" href="...">
  if (inlineStyles) {
    const linkPattern = /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi;
    const links = output.match(linkPattern) ?? [];
    for (const tag of links) {
      const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href) continue;
      const path = resolveUrl(href, baseDir);
      if (!path) continue;
      try {
        const file = Bun.file(path);
        if (!(await file.exists())) continue;
        const cssText = await file.text();
        const cssDir = path.slice(0, path.lastIndexOf("/")) || baseDir;
        const css = await inlineCssUrls(cssText, cssDir, maxBytes);
        output = output.replace(tag, `<style data-href="${href}">\n${css}\n</style>`);
      } catch {
        /* leave the original tag */
      }
    }
  }

  // src="..." and poster="..."
  output = await replaceAsync(output, /(<(?:img|source|video|audio|embed|iframe)\b[^>]*?\b(?:src|poster)=)(["'])([^"']+)\2/gi,
    async (_match, prefix: string, quote: string, url: string) => {
      const path = resolveUrl(url, baseDir);
      if (!path) return `${prefix}${quote}${url}${quote}`;
      const dataUri = await toDataUri(path, maxBytes);
      if (dataUri) return `${prefix}${quote}${dataUri}${quote}`;
      return `${prefix}${quote}${pathToFileUrl(path)}${quote}`;
    });

  // srcset="a.png 1x, b.png 2x"
  output = await replaceAsync(output, /(\bsrcset=)(["'])([^"']+)\2/gi,
    async (_match, prefix: string, quote: string, value: string) => {
      const parts = await Promise.all(
        value.split(",").map(async (entry) => {
          const [url, descriptor] = entry.trim().split(/\s+/);
          if (!url) return entry;
          const path = resolveUrl(url, baseDir);
          if (!path) return entry;
          const dataUri = await toDataUri(path, maxBytes);
          return [dataUri ?? pathToFileUrl(path), descriptor].filter(Boolean).join(" ");
        }),
      );
      return `${prefix}${quote}${parts.join(", ")}${quote}`;
    });

  // url(...) in inline <style> blocks
  output = await replaceAsync(output, /<style\b[^>]*>[\s\S]*?<\/style>/gi, async (block: string) =>
    inlineCssUrls(block, baseDir, maxBytes),
  );

  return output;
}

async function inlineCssUrls(css: string, baseDir: string, maxBytes: number): Promise<string> {
  return replaceAsync(css, /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    async (match: string, quote: string, url: string) => {
      if (url.startsWith("#") || url.startsWith("var(")) return match;
      const path = resolveUrl(url, baseDir);
      if (!path) return match;
      const dataUri = await toDataUri(path, maxBytes);
      if (dataUri) return `url(${quote}${dataUri}${quote})`;
      if (await Bun.file(path).exists()) return `url(${quote}${pathToFileUrl(path)}${quote})`;
      return match;
    });
}

export function pathToFileUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `${process.cwd()}/${path}`;
  return `file://${normalized.split("/").map(encodeURIComponent).join("/").replace(/^file:\/\/%2F/, "file:///")}`;
}

/** Replace with async support (String.replace cannot await). */
async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (...args: any[]) => Promise<string>,
): Promise<string> {
  const jobs: Array<Promise<string>> = [];
  input.replace(pattern, (...args: any[]) => {
    jobs.push(replacer(...args));
    return "";
  });
  if (jobs.length === 0) return input;

  const resolved = await Promise.all(jobs);
  let index = 0;
  return input.replace(pattern, () => resolved[index++]!);
}
