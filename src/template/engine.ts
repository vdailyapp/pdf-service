/**
 * Mustache-compatible template engine.
 *
 * Implements the subset that matters for document generation:
 *   {{path.to.value}}        escaped interpolation
 *   {{{raw}}} / {{& raw}}    raw interpolation
 *   {{#section}}…{{/section}}  arrays iterate, objects push scope, truthy renders once
 *   {{^section}}…{{/section}}  inverted section
 *   {{> partial}}            partials
 *   {{! comment }}           comments
 *   {{helper arg "lit" 3}}   helper call (last arg resolves as the value)
 *
 * Section scopes expose `{{.}}`, `{{@index}}`, `{{@key}}`, `{{@first}}`, `{{@last}}`.
 * Deliberately has no `eval`, so untrusted templates/data cannot execute code.
 */

export type TemplateData =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null
  | undefined;

export type Helper = (value: unknown, args: unknown[], context: Record<string, unknown>) => unknown;

export type TemplateOptions = {
  /** Helper registry. Merged over the built-in helpers. */
  helpers?: Record<string, Helper>;
  /** Named partials: `{{> name}}`. */
  partials?: Record<string, string>;
  /** Layout template containing `{{{body}}}`. */
  layout?: string;
  /** Escape interpolations. Default true. */
  escape?: boolean;
  /** Fail on missing variables instead of rendering an empty string. */
  strict?: boolean;
};

type Node =
  | { kind: "text"; value: string }
  | { kind: "var"; expr: string; raw: boolean; offset: number }
  | { kind: "section"; expr: string; inverted: boolean; children: Node[]; offset: number }
  | { kind: "partial"; name: string };

class Scope {
  constructor(
    readonly value: unknown,
    readonly parent: Scope | null,
    readonly meta: Record<string, unknown> = {},
  ) {}

  lookup(path: string): unknown {
    if (path === "." || path === "this") return this.value;

    if (path.startsWith("@")) {
      let scope: Scope | null = this;
      while (scope) {
        if (path in scope.meta) return scope.meta[path];
        // `@root` and friends may live on any ancestor.
        if (path === "@root" && scope.parent === null) return scope.value;
        scope = scope.parent;
      }
      if (path === "@root") {
        let root: Scope = this;
        while (root.parent) root = root.parent;
        return root.value;
      }
      return undefined;
    }

    const [head, ...rest] = path.split(".");
    let scope: Scope | null = this;
    let current: unknown;

    while (scope) {
      const container: unknown = scope.value;
      // Own properties only: `{{constructor}}` must not reach Object.prototype.
      if (isObject(container) && isSafeOwnKey(container, head!)) {
        current = (container as Record<string, unknown>)[head!];
        break;
      }
      scope = scope.parent;
    }

    if (rest.length === 0) return current;

    let cursor: unknown = current;
    for (const key of rest) {
      if (cursor === null || cursor === undefined) return undefined;
      if (!isObject(cursor)) return undefined;
      if (!isSafeOwnKey(cursor, key)) return undefined;
      cursor = (cursor as Record<string, unknown>)[key];
    }
    return cursor;
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Only own, non-prototype keys are reachable from templates. Without this,
 * `{{constructor}}` renders `Object` and `{{constructor.constructor}}` would
 * hand a template author the Function constructor.
 */
function isSafeOwnKey(target: object, key: string): boolean {
  if (FORBIDDEN_KEYS.has(key)) return false;
  return Object.hasOwn(target, key);
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/* ------------------------------------------------------------------ parsing */

function findTag(source: string, from: number): { start: number; end: number; inner: string; raw: boolean } | null {
  let index = source.indexOf("{{", from);
  if (index === -1) return null;

  // Mustache-spec style: `{{{ … }}}` for raw output.
  if (source[index + 2] === "{") {
    const close = source.indexOf("}}}", index + 3);
    if (close === -1) return null;
    return { start: index, end: close + 3, inner: source.slice(index + 3, close), raw: true };
  }

  const close = source.indexOf("}}", index + 2);
  if (close === -1) return null;
  return { start: index, end: close + 2, inner: source.slice(index + 2, close), raw: false };
}

function parse(source: string, depth = 0): Node[] {
  if (depth > 32) throw new TemplateError("Template nesting too deep (check partial recursion)");

  const nodes: Node[] = [];
  let cursor = 0;
  let buffer = "";

  const flush = () => {
    if (buffer) {
      nodes.push({ kind: "text", value: buffer });
      buffer = "";
    }
  };

  while (cursor < source.length) {
    const tag = findTag(source, cursor);
    if (!tag) {
      buffer += source.slice(cursor);
      break;
    }

    buffer += source.slice(cursor, tag.start);
    cursor = tag.end;

    let inner = tag.inner.trim();

    if (inner.startsWith("!")) continue; // comment

    if (inner.startsWith("#") || inner.startsWith("^")) {
      const inverted = inner.startsWith("^");
      const expr = inner.slice(1).trim();
      flush();

      const end = findSectionEnd(source, cursor, expr);
      if (!end) throw new TemplateError(`Unclosed section {{#${expr}}}`);

      const children = parse(source.slice(cursor, end.start), depth + 1);
      nodes.push({ kind: "section", expr, inverted, children, offset: tag.start });
      cursor = end.end;
      continue;
    }

    if (inner.startsWith("/")) {
      throw new TemplateError(`Unexpected closing tag {{/${inner.slice(1).trim()}}} at offset ${tag.start}`);
    }

    if (inner.startsWith(">")) {
      flush();
      nodes.push({ kind: "partial", name: inner.slice(1).trim() });
      continue;
    }

    if (inner.startsWith("&")) {
      inner = inner.slice(1).trim();
      flush();
      nodes.push({ kind: "var", expr: inner, raw: true, offset: tag.start });
      continue;
    }

    flush();
    nodes.push({ kind: "var", expr: inner, raw: tag.raw, offset: tag.start });
  }

  flush();
  return nodes;
}

function findSectionEnd(
  source: string,
  from: number,
  name: string,
): { start: number; end: number } | null {
  // Section expressions may carry helper arguments (`{{#gt total 0}}`), while
  // the closing tag only names the helper (`{{/gt}}`). Compare base names.
  const base = (expr: string) => expr.split(/\s+/)[0] ?? "";
  const wanted = base(name);
  let cursor = from;
  let nesting = 0;

  while (cursor < source.length) {
    const tag = findTag(source, cursor);
    if (!tag) return null;

    const inner = tag.inner.trim();
    if (inner.startsWith("#") || inner.startsWith("^")) {
      if (base(inner.slice(1).trim()) === wanted) nesting++;
    } else if (inner.startsWith("/")) {
      if (base(inner.slice(1).trim()) === wanted) {
        if (nesting === 0) return { start: tag.start, end: tag.end };
        nesting--;
      }
    }
    cursor = tag.end;
  }

  return null;
}

/* ------------------------------------------------------------------ helpers */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => HTML_ESCAPES[char]!);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function truthy(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/* ------------------------------------------------------------ interpolation */

/**
 * Expressions are space-separated, Lisp-style: `currency (multiply qty price) "VND"`.
 * Parentheses group a sub-expression anywhere an argument is allowed.
 */
type Token = { kind: "word" | "string"; value: string };

function tokenizeExpr(expr: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  const flushWord = () => {
    if (word) {
      tokens.push({ kind: "word", value: word });
      word = "";
    }
  };

  for (let index = 0; index < expr.length; index++) {
    const char = expr[index]!;

    if (char === '"' || char === "'") {
      flushWord();
      let literal = "";
      index++;
      for (; index < expr.length; index++) {
        const inner = expr[index]!;
        if (inner === "\\" && index + 1 < expr.length) {
          literal += expr[++index]!;
          continue;
        }
        if (inner === char) break;
        literal += inner;
      }
      tokens.push({ kind: "string", value: literal });
      continue;
    }

    if (char === "(" || char === ")") {
      flushWord();
      tokens.push({ kind: "word", value: char });
      continue;
    }

    if (/\s/.test(char)) {
      flushWord();
      continue;
    }

    word += char;
  }

  flushWord();
  return tokens;
}

type Atom =
  | { kind: "string"; value: string }
  | { kind: "literal"; value: unknown }
  | { kind: "path"; path: string }
  | { kind: "expr"; tokens: Token[] };

/**
 * Turn tokens into top-level atoms. Parenthesised groups become nested
 * expressions, so `currency (multiply qty price) "VND"` parses as three atoms.
 */
function parseAtoms(tokens: Token[]): Atom[] {
  const atoms: Atom[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]!;

    if (token.kind === "word" && token.value === "(") {
      let depth = 1;
      const inner: Token[] = [];
      index++;
      while (index < tokens.length) {
        const nested = tokens[index]!;
        if (nested.kind === "word" && nested.value === "(") depth++;
        else if (nested.kind === "word" && nested.value === ")") {
          depth--;
          if (depth === 0) break;
        }
        inner.push(nested);
        index++;
      }
      if (depth !== 0) throw new TemplateError("Unbalanced parentheses in template expression");
      atoms.push({ kind: "expr", tokens: inner });
      index++;
      continue;
    }

    if (token.kind === "word" && token.value === ")") {
      throw new TemplateError("Unbalanced parentheses in template expression");
    }

    if (token.kind === "string") {
      atoms.push({ kind: "string", value: token.value });
    } else if (isLiteralWord(token.value)) {
      atoms.push({ kind: "literal", value: literalValue(token.value) });
    } else {
      atoms.push({ kind: "path", path: token.value });
    }
    index++;
  }

  return atoms;
}

function isLiteralWord(token: string): boolean {
  return (
    token === "true" ||
    token === "false" ||
    token === "null" ||
    token === "undefined" ||
    /^-?\d+(\.\d+)?$/.test(token)
  );
}

function literalValue(token: string): unknown {
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null") return null;
  if (token === "undefined") return undefined;
  return Number(token);
}

/* ----------------------------------------------------------------- renderer */

const DEFAULT_HELPERS: Record<string, Helper> = {
  upper: (value) => stringify(value).toUpperCase(),
  lower: (value) => stringify(value).toLowerCase(),
  trim: (value) => stringify(value).trim(),
  default: (value, args) => (value === undefined || value === null || value === "" ? args[0] : value),
  json: (value, args) =>
    JSON.stringify(value, null, typeof args[0] === "number" ? args[0] : 0) ?? "",
  length: (value) => (Array.isArray(value) ? value.length : stringify(value).length),
  sum: (value, args) => {
    if (!Array.isArray(value)) return 0;
    const key = typeof args[0] === "string" ? args[0] : null;
    return value.reduce<number>((total, item) => {
      const raw = key && isObject(item) ? (item as Record<string, unknown>)[key] : item;
      const num = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(num) ? total + num : total;
    }, 0);
  },
  count: (value) => (Array.isArray(value) ? value.length : 0),
};

export function render(source: string, data: TemplateData = {}, options: TemplateOptions = {}): string {
  const helpers = { ...DEFAULT_HELPERS, ...(options.helpers ?? {}) };
  const partials = options.partials ?? {};
  const escape = options.escape !== false;

  const evaluate = (expr: string, scope: Scope): unknown => {
    const atoms = parseAtoms(tokenizeExpr(expr));
    if (atoms.length === 0) return undefined;

    // Single atom: plain interpolation of a variable or literal.
    if (atoms.length === 1) {
      const value = evalAtom(atoms[0]!, scope);
      if (options.strict && value === undefined && atoms[0]!.kind === "path" && !atoms[0]!.path.startsWith("@")) {
        return new MissingValue(expr);
      }
      return value;
    }

    // Multiple atoms: first is the helper name, the rest are its arguments.
    const head = atoms[0]!;
    if (head.kind !== "path") {
      throw new TemplateError(`Helper name expected at start of {{${expr}}}`);
    }
    const helper = helpers[head.path];
    if (!helper) throw new TemplateError(`Unknown helper "${head.path}" in {{${expr}}}`);

    const args = atoms.slice(1).map((atom) => evalAtom(atom, scope));
    return helper(args[0], args.slice(1), data as Record<string, unknown>);
  };

  /** Resolve one atom; a nested `(…)` group evaluates as its own expression. */
  function evalAtom(atom: Atom, scope: Scope): unknown {
    switch (atom.kind) {
      case "string":
      case "literal":
        return atom.value;
      case "path":
        return scope.lookup(atom.path);
      case "expr":
        return evaluateTokens(atom.tokens, scope);
    }
  }

  function evaluateTokens(tokens: Token[], scope: Scope): unknown {
    const atoms = parseAtoms(tokens);
    if (atoms.length === 0) return undefined;
    if (atoms.length === 1) return evalAtom(atoms[0]!, scope);

    const head = atoms[0]!;
    if (head.kind !== "path") {
      throw new TemplateError("Helper name expected inside nested expression");
    }
    const helper = helpers[head.path];
    if (!helper) throw new TemplateError(`Unknown helper "${head.path}"`);
    const args = atoms.slice(1).map((atom) => evalAtom(atom, scope));
    return helper(args[0], args.slice(1), data as Record<string, unknown>);
  }

  const renderNodes = (nodes: Node[], scope: Scope): string => {
    let out = "";

    for (const node of nodes) {
      switch (node.kind) {
        case "text":
          out += node.value;
          break;

        case "var": {
          const value = evaluate(node.expr, scope);
          if (value instanceof MissingValue) {
            throw new TemplateError(`Missing value for {{${node.expr}}} at offset ${node.offset}`);
          }
          const text = stringify(value);
          out += node.raw || !escape ? text : escapeHtml(text);
          break;
        }

        case "partial": {
          const partial = partials[node.name];
          if (partial === undefined) {
            throw new TemplateError(`Unknown partial "{{> ${node.name}}}"`);
          }
          out += renderNodes(parse(partial), scope);
          break;
        }

        case "section": {
          const value = evaluate(node.expr, scope);
          if (node.inverted) {
            if (!truthy(value)) out += renderNodes(node.children, scope);
            break;
          }

          if (!truthy(value)) break;

          if (Array.isArray(value)) {
            const last = value.length - 1;
            value.forEach((item, index) => {
              out += renderNodes(
                node.children,
                new Scope(item, scope, {
                  "@index": index,
                  "@first": index === 0,
                  "@last": index === last,
                }),
              );
            });
            break;
          }

          if (isObject(value)) {
            out += renderNodes(node.children, new Scope(value, scope));
            break;
          }

          // Truthy scalar: push it so `{{.}}` works, lookups still fall through.
          out += renderNodes(node.children, new Scope(value, scope));
          break;
        }
      }
    }

    return out;
  };

  let output = renderNodes(parse(source), new Scope(data, null));

  if (options.layout) {
    const layoutData = isObject(data) && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), body: new RawHtml(output) }
      : { body: new RawHtml(output) };
    output = render(options.layout, layoutData, { ...options, layout: undefined });
  }

  return output;
}

/** Wrapper so layout `{{{body}}}` is never escaped regardless of options. */
class RawHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

class MissingValue {
  constructor(readonly expr: string) {}
}

/** Render a template file from disk. */
export async function renderFile(
  templatePath: string,
  data: TemplateData = {},
  options: TemplateOptions = {},
): Promise<string> {
  const file = Bun.file(templatePath);
  if (!(await file.exists())) throw new TemplateError(`Template not found: ${templatePath}`);
  return render(await file.text(), data, options);
}
