# pdfsmith

**Bun-native PDF engine.** Two jobs, one pipeline:

1. **Render complex HTML/CSS to PDF** — Chrome does the layout, so flexbox, grid, `@page`, web fonts, SVG, gradients, `break-inside` and every other thing you have ever fought a PDF library over simply work.
2. **Fill templates with data and print them** — an HTML template language with partials, layouts, nested helpers, and invoice-grade formatting (VND currency, Vietnamese number-to-words, dates).

Zero runtime dependencies. Uses the Chrome already on your machine through the DevTools Protocol, on Bun's built-in `WebSocket`.

```ts
import { loadTemplate } from "pdfsmith";

const invoice = await loadTemplate("./templates/invoice");
const { bytes, pageCount } = await invoice.toPdf(data);
await Bun.write("invoice.pdf", bytes);
```

---

## Install

```bash
bun add pdfsmith
```

Requires **Bun ≥ 1.1** and a Chrome/Chromium binary. Nothing else — no `puppeteer`, no `playwright`, no headless-shell download.

Discovery order:

1. `PDFSMITH_CHROME_PATH` environment variable
2. Google Chrome, Chromium, Microsoft Edge (macOS / Linux / Windows default locations)

If you only have a CI image without a browser:

```bash
bunx playwright install chromium
export PDFSMITH_CHROME_PATH=$(bunx playwright install --dry-run chromium | grep -o '/[^ ]*chrome')
```

Check everything before you debug your template:

```bash
bun run src/cli.ts doctor
```

```
✔ Browser   chrome — Google Chrome 155.0.8059.85
✔ Bun       1.4.4
✔ Print     7571 bytes in 522ms
✔ Ready
```

---

## Quick start

### Render HTML

```ts
import { renderHtmlToPdf } from "pdfsmith";

const { bytes, pageCount, timings } = await renderHtmlToPdf(
  `<h1 style="font-family:Georgia">Xin chào</h1><p>Nội dung</p>`,
  {
    format: "A4",
    margin: "12mm",
    title: "Tài liệu",
    footer: `<div style="font-size:8px;width:100%;text-align:center">
               Trang <span class="pageNumber"></span>/<span class="totalPages"></span>
             </div>`,
  },
);
```

### Batch: reuse one browser

Launching Chrome costs ~400 ms; printing costs ~80 ms. For batches, launch once:

```ts
import { launchBrowser, loadTemplate } from "pdfsmith";

const browser = await launchBrowser();
try {
  const template = await loadTemplate("./templates/invoice");
  for (const invoice of invoices) {
    const { bytes } = await template.toPdf(invoice, { browser });
    await Bun.write(`out/${invoice.number}.pdf`, bytes);
  }
} finally {
  await browser.close();
}
```

### Templates from a directory

```
templates/invoice/
├── index.html               # entry
├── invoice.css              # inlined automatically
├── letterhead.partial.html  # {{> letterhead}}
├── signature.partial.html   # {{> signature}}
└── layout.html              # optional wrapper, {{{body}}}
```

```ts
const invoice = await loadTemplate("./templates/invoice");
```

Partials are auto-loaded from `*.partial.html`; `layout.html` is applied if present. Relative `href`/`src` in the template resolve **against the template's own directory**, not the process cwd — so the same template works from a script, a CLI call, or a server.

---

## Template language

Mustache-compatible, plus helpers and nested expressions.

| Syntax | Meaning |
|---|---|
| `{{name}}` | Escaped interpolation |
| `{{{html}}}` / `{{& html}}` | Raw interpolation |
| `{{a.b.c}}` / `{{.}}` | Path lookup / current item |
| `{{#items}}…{{/items}}` | Iterate array; push object scope; render once if truthy |
| `{{^items}}…{{/items}}` | Inverted (falsy) section |
| `{{> partial}}` | Partial |
| `{{! note }}` | Comment |
| `{{helper value arg "literal" 3}}` | Helper call |
| `{{a (b x) (c y)}}` | Nested helper calls |
| `{{@index}} {{@first}} {{@last}}` | Loop metadata |

```html
{{#items}}
  <tr>
    <td>{{pad @index 2}}</td>
    <td>{{name}}</td>
    <td>{{currency (multiply quantity unitPrice 0) "VND"}}</td>
  </tr>
{{/items}}
```

### Available helpers

**Template built-ins:** `upper`, `lower`, `trim`, `default`, `json`, `length`, `count`, `sum`.

**Document helpers** (always loaded in `PdfTemplate`):

| Helper | Example | Result |
|---|---|---|
| `currency` | `{{currency 1250000 "VND"}}` | `1.250.000 ₫` |
| `number` | `{{number 1234.5 2}}` | `1,234.50` |
| `date` | `{{date "2026-10-23" "dmy"}}` | `23/10/2026` |
| `words` | `{{words 125070000}}` | `Một trăm hai mươi lăm triệu không trăm bảy mươi nghìn đồng` |
| `multiply` | `{{multiply qty price 0}}` | rounded product |
| `sum` | `{{sum items "total"}}` | array sum |
| `percent` | `{{percent 1000 10}}` | `100` |
| `slug` | `{{slug "Hoá đơn 01"}}` | `hoa-don-01` |
| `pad`, `eq`, `gt` | — | — |

Add your own:

```ts
import { PdfTemplate } from "pdfsmith";

const template = new PdfTemplate({ html: "{{shout name}}" })
  .helper("shout", (value) => `${String(value).toUpperCase()}!`);
```

### Design tokens

One stylesheet, many brands:

```ts
const template = await loadTemplate("./templates/invoice", {
  tokens: { brand: "#1d4ed8", "font-body": "Inter" },
});
```

becomes `:root { --brand: #1d4ed8; --font-body: Inter; }`. Token names are validated, so a data-driven token key cannot break out of the CSS block.

### Strict mode

By default a missing variable renders empty. `strict: true` throws with the template offset instead — recommended while building a template, noisy in production.

---

## Render options

| Option | Default | Notes |
|---|---|---|
| `format` | `"A4"` | `A3`…`A6`, `Letter`, `Legal`, `Tabloid`, `[w, h]` inches |
| `landscape` | `false` | Chrome handles orientation; do not swap dimensions yourself |
| `margin` | `0` | `0.5` (inches), `"12mm"`, or `{top,right,bottom,left}` |
| `printBackground` | `true` | Gradients and background colors |
| `scale` | `1` | `0.1`–`2` |
| `pageRanges` | — | `"1-3,5"` |
| `preferCSSPageSize` | `true` | Let `@page { size: … }` win |
| `header` / `footer` | — | HTML; `.pageNumber`, `.totalPages`, `.date`, `.title`, `.url` |
| `headerFooterMargin` | `0.3` | Distance from paper edge (inches); content margin auto-expands |
| `watermark` | — | `"BẢN NHÁP"` or `{text, color, opacity, fontSize, angle}` |
| `css` | — | Extra CSS appended before printing |
| `waitForSelector` | — | Block until an element exists |
| `waitForFunction` | — | Block until a JS expression is truthy |
| `waitAfterLoad` | `0` | Extra settle time (ms) |
| `timeoutMs` | `30000` | Navigation + wait budget |
| `inlineAssets` | `true` | `false` to disable, or `{baseDir}` |
| `outline` | `true` | PDF bookmarks from headings |
| `tagged` | `false` | Tagged PDF (accessibility; larger files) |
| `title` | — | PDF metadata |

The pipeline always waits for `document.fonts.ready` and every `<img>` before printing — that is what prevents the classic blank-page and fallback-font PDFs.

---

## CLI

```bash
# Render HTML
pdfsmith render invoice.html -o invoice.pdf --format A4 --margin 12mm

# Fill a template directory with JSON
pdfsmith fill templates/invoice -d data.json -o out/invoice.pdf \
  --footer '<div style="font-size:8px;width:100%;text-align:center">Trang <span class="pageNumber"></span>/<span class="totalPages"></span></div>'

# JSON from a pipe, HTML from stdin
cat payload.json | pdfsmith fill templates/invoice -d - -o out.pdf
echo '<h1>Hi</h1>' | pdfsmith render - -o hi.pdf --landscape

# Environment check
pdfsmith doctor
```

Run it without installing:

```bash
bun run src/cli.ts fill examples/invoice -d examples/invoice/data.json -o invoice.pdf
```

Useful flags: `--watermark`, `--page-ranges`, `--header`, `--footer`, `--css`, `--title`, `--wait-for`, `--no-inline`, `--keep-html` (dumps the intermediate HTML), `--headful`.

---

## Diagnostics: measure instead of guessing

The most common PDF bug is "why is this two pages?" — and the answer is usually 40 px of padding, not a library problem. `scripts/measure.ts` reports real layout boxes in print media:

```bash
bun run scripts/measure.ts examples/invoice
```

```
Page box:     794 × 1123 px (A4)
Body height:  985 px → 0.88 pages

    49 →    103     54px  header.letterhead
   117 →    188     72px  section.title-row
   200 →    310    110px  section.parties
   322 →    528    205px  table.items
   540 →    644    104px  section.totals
   656 →    752     96px  section.payment
   762 →    827     65px  section.notes
   841 →    936     95px  section.signature
```

When a block overflows the first page boundary it is marked, so you know which element to shrink rather than editing CSS blind.

---

## What is in the box

```
src/
├── browser/cdp.ts        # DevTools Protocol client on Bun's WebSocket
├── browser/launcher.ts   # Chrome discovery, launch, flat-session pages
├── render/print.ts       # HTML → PDF: paper, margins, header/footer, watermark
├── template/engine.ts    # Mustache-compatible engine, nested helpers, partials
├── template/document.ts  # PdfTemplate: template + data + print
├── template/helpers.ts   # currency/date/words/slug formatting
├── assets/inline.ts      # data-URI inlining for local CSS, images, fonts
└── cli.ts                # render | fill | doctor
examples/
├── invoice/              # Vietnamese invoice: gradients, grid, signature block
└── report/               # dashboard report: CSS-only bar chart, page headers
scripts/measure.ts        # layout diagnostics
test/                     # 60 tests, including real Chrome round-trips
```

---

## Design decisions

**Delegate layout to Chrome.** Every attempt to implement CSS in JavaScript produces a library that is 80% right and 100% surprising. Blink is already installed and already correct.

**No HTTP server.** Relative assets are rewritten to `data:` URIs (with a `file://` fallback for oversized files) instead of spinning up a local server. Templates stay portable and nothing leaks on a port.

**Documents larger than 1.8 MB use a temp file.** Chrome's `data:` URL limit would silently truncate them; the file is deleted after the page parses.

**Templates cannot execute code.** No `eval`, no expression language with side effects. Lookups are own-property only, so `{{constructor}}` and `{{constructor.constructor}}` resolve to nothing instead of exposing `Function`.

**Business rules live in TypeScript, not templates.** Templates format; they do not compute tax. The invoice example computes subtotal/VAT in code and passes the result in — testable, reviewable, and identical across runs.

---

## Limitations

- **Not a PDF editor.** No merging, splitting, signing, or form filling. Use `qpdf`/`pdf-lib` for that.
- **Not for serverless cold starts.** Chrome launch is ~400 ms and needs a real binary; on Lambda/Cloudflare use a hosted renderer instead.
- **`countPages` targets Chrome output.** It scans uncompressed page objects; PDFs with object streams report `0` (kept honest rather than guessed).
- **Fonts must be available.** Use web fonts in the template or install system fonts; Chrome will substitute otherwise.

---

## Scripts

```bash
bun test              # 60 tests (engine + real Chrome round-trips)
bun run examples/render.ts   # builds the two sample PDFs
bunx tsc --noEmit     # typecheck
bun run src/cli.ts doctor
```

---

MIT © Nguyen
