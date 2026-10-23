import { describe, expect, test } from "bun:test";
import { escapeHtml, render, TemplateError } from "../src/template/engine.ts";
import { documentHelpers, numberToVietnameseWords, formatCurrency, formatDate, slugify } from "../src/template/helpers.ts";

describe("template: interpolation", () => {
  test("replaces simple paths", () => {
    expect(render("Hi {{name}}", { name: "Nguyen" })).toBe("Hi Nguyen");
  });

  test("walks nested paths", () => {
    expect(render("{{a.b.c}}", { a: { b: { c: 42 } } })).toBe("42");
  });

  test("escapes HTML by default", () => {
    expect(render("{{x}}", { x: "<b>&" })).toBe("&lt;b&gt;&amp;");
  });

  test("raw interpolation skips escaping", () => {
    expect(render("{{{x}}}", { x: "<b>ok</b>" })).toBe("<b>ok</b>");
    expect(render("{{& x}}", { x: "<b>ok</b>" })).toBe("<b>ok</b>");
  });

  test("escape can be disabled globally", () => {
    expect(render("{{x}}", { x: "<b>" }, { escape: false })).toBe("<b>");
  });

  test("missing values render empty unless strict", () => {
    expect(render("[{{nope}}]", {})).toBe("[]");
    expect(() => render("[{{nope}}]", {}, { strict: true })).toThrow(TemplateError);
  });

  test("null and undefined render empty, zero renders", () => {
    expect(render("{{a}}{{b}}{{c}}", { a: null, b: undefined, c: 0 })).toBe("0");
  });

  test("comments are stripped", () => {
    expect(render("a{{! hidden }}b", {})).toBe("ab");
  });
});

describe("template: sections", () => {
  test("iterates arrays and exposes @index/@first/@last", () => {
    const out = render(
      '{{#items}}[{{@index}}{{#@first}}F{{/@first}}{{#@last}}L{{/@last}}:{{name}}]{{/items}}',
      { items: [{ name: "a" }, { name: "b" }, { name: "c" }] },
    );
    expect(out).toBe("[0F:a][1:b][2L:c]");
  });

  test("empty array renders nothing", () => {
    expect(render("x{{#items}}y{{/items}}z", { items: [] })).toBe("xz");
  });

  test("object section pushes scope but keeps parent lookups", () => {
    const out = render("{{#user}}{{name}}/{{company}}{{/user}}", {
      company: "Acme",
      user: { name: "Nguyen" },
    });
    expect(out).toBe("Nguyen/Acme");
  });

  test("inverted section renders when falsy", () => {
    expect(render("{{^items}}none{{/items}}", { items: [] })).toBe("none");
    expect(render("{{^items}}none{{/items}}", { items: [1] })).toBe("");
  });

  test("scalar section renders once with {{.}}", () => {
    expect(render("{{#flag}}on:{{.}}{{/flag}}", { flag: true })).toBe("on:true");
    expect(render("{{#count}}n={{.}}{{/count}}", { count: 3 })).toBe("n=3");
  });

  test("deeply nested sections resolve correctly", () => {
    const template =
      "{{#groups}}{{#members}}{{g}}:{{name}};{{/members}}{{/groups}}";
    const out = render(template, {
      groups: [
        { members: [{ name: "a" }, { name: "b" }] },
        { members: [{ name: "c" }] },
      ],
    });
    // `g` is intentionally missing: lookups fall through to the root, not fail.
    expect(out).toBe(":a;:b;:c;");
  });

  test("nested sections with the same name nest properly", () => {
    expect(render("{{#a}}1{{#a}}2{{/a}}3{{/a}}", { a: [1] })).toBe("123");
  });

  test("unclosed section throws a useful error", () => {
    expect(() => render("{{#a}}", { a: 1 })).toThrow(/Unclosed section/);
  });
});

describe("template: helpers", () => {
  test("built-in string helpers", () => {
    expect(render('{{upper name}}', { name: "nguyen" })).toBe("NGUYEN");
    expect(render('{{lower name}}', { name: "NGUYEN" })).toBe("nguyen");
    expect(render("{{trim name}}", { name: "  x  " })).toBe("x");
    expect(render("{{length items}}", { items: [1, 2, 3] })).toBe("3");
  });

  test("default helper falls back for empty values", () => {
    expect(render('{{default name "N/A"}}', { name: "" })).toBe("N/A");
    expect(render('{{default name "N/A"}}', { name: "x" })).toBe("x");
  });

  test("nested helper calls", () => {
    const out = render('{{upper (lower name)}}', { name: "Nguyen" });
    expect(out).toBe("NGUYEN");
  });

  test("three levels of nesting", () => {
    const out = render('{{upper (trim (lower name))}}', { name: "  AbC  " });
    expect(out).toBe("ABC");
  });

  test("helpers receive literal string and numeric args", () => {
    const out = render(
      '{{currency (multiply qty price 0) "VND"}}',
      { qty: 3, price: 2_500_000 },
      { helpers: documentHelpers },
    );
    expect(out).toContain("7.500.000");
    expect(out).toContain("₫");
  });

  test("custom helpers take priority", () => {
    const out = render("{{shout word}}", { word: "hi" }, { helpers: { shout: (v) => `${v}!` } });
    expect(out).toBe("hi!");
  });

  test("unknown helper throws", () => {
    expect(() => render("{{nope x}}", { x: 1 })).toThrow(/Unknown helper/);
  });

  test("unbalanced parens throw", () => {
    expect(() => render("{{upper (lower x}}", { x: "a" })).toThrow(/Unbalanced/);
  });
});

describe("template: partials and layout", () => {
  test("renders partials with the current scope", () => {
    const out = render("{{> row}}", { name: "Nguyen" }, { partials: { row: "<b>{{name}}</b>" } });
    expect(out).toBe("<b>Nguyen</b>");
  });

  test("unknown partial throws", () => {
    expect(() => render("{{> nope}}", {})).toThrow(/Unknown partial/);
  });

  test("layout wraps body unescaped", () => {
    const out = render("<p>{{x}}</p>", { x: "hi" }, {
      layout: "<html><body>{{{body}}}</body></html>",
    });
    expect(out).toBe("<html><body><p>hi</p></body></html>");
  });
});

describe("helpers: formatting", () => {
  test("formatCurrency renders VND without decimals", () => {
    const text = formatCurrency(1_250_000, "VND", "vi-VN");
    expect(text).toContain("1.250.000");
    expect(text).not.toContain(",00");
  });

  test("formatDate keeps bare ISO dates on the same day", () => {
    expect(formatDate("2026-10-23", "dmy")).toBe("23/10/2026");
    expect(formatDate("2026-10-23", "iso")).toBe("2026-10-23");
  });

  test("slugify strips Vietnamese diacritics", () => {
    expect(slugify("Hoá đơn số 01")).toBe("hoa-don-so-01");
  });

  test("numberToVietnameseWords handles the tricky cases", () => {
    expect(numberToVietnameseWords(0)).toBe("Không đồng");
    expect(numberToVietnameseWords(1_000)).toBe("Một nghìn đồng");
    expect(numberToVietnameseWords(15)).toBe("Mười lăm đồng");
    expect(numberToVietnameseWords(21)).toBe("Hai mươi mốt đồng");
    expect(numberToVietnameseWords(105)).toBe("Một trăm lẻ năm đồng");
    expect(numberToVietnameseWords(2_000_000)).toBe("Hai triệu đồng");
    expect(numberToVietnameseWords(1_234_567)).toBe(
      "Một triệu hai trăm ba mươi bốn nghìn năm trăm sáu mươi bảy đồng",
    );
    expect(numberToVietnameseWords(125_070_000)).toBe(
      "Một trăm hai mươi lăm triệu không trăm bảy mươi nghìn đồng",
    );
  });

  test("documentHelpers are wired to the engine", () => {
    expect(render('{{currency total}}', { total: 1000 }, { helpers: documentHelpers })).toContain(
      "1.000",
    );
    expect(render('{{date d "iso"}}', { d: "2026-01-05" }, { helpers: documentHelpers })).toBe(
      "2026-01-05",
    );
  });
});

describe("escapeHtml", () => {
  test("escapes every dangerous character", () => {
    expect(escapeHtml(`<>&"'\``)).toBe("&lt;&gt;&amp;&quot;&#39;&#96;");
  });
});
