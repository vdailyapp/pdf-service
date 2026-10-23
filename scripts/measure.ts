#!/usr/bin/env bun
/**
 * Diagnostic: measure the printed layout of a template, so you can see *why*
 * a document breaks across pages instead of guessing from the PDF.
 *
 *   bun run scripts/measure.ts examples/invoice
 */

import { launchBrowser } from "../src/browser/launcher.ts";
import { inlineAssets } from "../src/assets/inline.ts";
import { loadTemplate } from "../src/template/document.ts";
import { documentHelpers } from "../src/template/helpers.ts";
import { multiply } from "../src/template/helpers.ts";

const target = process.argv[2] ?? `${import.meta.dir}/../examples/invoice`;
const baseDir = `${process.cwd()}/${target}`.replace(/\/[^/]+$/, "");
const dirName = target.replace(/\/$/, "");
const template = await loadTemplate(target, { template: { helpers: documentHelpers } });

let data: Record<string, unknown> = {};
const dataFile = Bun.file(`${dirName}/data.json`);
if (await dataFile.exists()) data = (await dataFile.json()) as Record<string, unknown>;

if (target.includes("invoice") && Array.isArray(data.items)) {
  const items = data.items as Array<{ quantity: number; unitPrice: number }>;
  const subtotal = items.reduce((total, item) => total + multiply(item.quantity, item.unitPrice, 0), 0);
  const totals = (data.totals ?? {}) as { discount?: number; vatRate?: number };
  const discount = totals.discount ?? 0;
  const vat = Math.round(((subtotal - discount) * (totals.vatRate ?? 0)) / 100);
  data = {
    ...data,
    totals: { ...totals, subtotal, vat, grand: subtotal - discount + vat },
  };
}

const html = await inlineAssets(await template.toHtml(data), { baseDir: dirName });

const browser = await launchBrowser();
try {
  const { sessionId } = await browser.newPage();
  const url = `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
  await browser.connection.send("Page.navigate", { url }, sessionId);
  await Bun.sleep(600);
  await browser.connection.send("Emulation.setEmulatedMedia", { media: "print" }, sessionId);

  const { result } = await browser.connection.send<{ result: { value: any } }>(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const pageHeight = (297 / 25.4) * 96;   // A4 in CSS px
        const pageWidth = (210 / 25.4) * 96;
        const blocks = [...document.body.children].map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            cls: el.className || null,
            top: Math.round(rect.top),
            height: Math.round(rect.height),
            bottom: Math.round(rect.bottom),
          };
        });
        const overflowing = blocks.filter((b) => b.bottom > pageHeight);
        return {
          pageHeight: Math.round(pageHeight),
          pageWidth: Math.round(pageWidth),
          bodyHeight: Math.round(document.body.getBoundingClientRect().height),
          scrollHeight: Math.round(document.documentElement.scrollHeight),
          blocks,
          overflowing,
        };
      })()`,
      returnByValue: true,
    },
    sessionId,
  );

  const m = result.value;
  console.log(`Page box:     ${m.pageWidth} × ${m.pageHeight} px (A4)`);
  console.log(`Body height:  ${m.bodyHeight} px → ${(m.bodyHeight / m.pageHeight).toFixed(2)} pages`);
  console.log("");
  for (const block of m.blocks) {
    const mark = block.bottom > m.pageHeight ? " ✖ overflows" : "";
    console.log(
      `${String(block.top).padStart(6)} → ${String(block.bottom).padStart(6)}  ` +
        `${String(block.height).padStart(5)}px  ${block.tag}.${block.cls ?? ""}${mark}`,
    );
  }
  if (m.overflowing.length) {
    console.log(`\n${m.overflowing.length} block(s) cross the first page boundary.`);
  }
} finally {
  await browser.close();
}
