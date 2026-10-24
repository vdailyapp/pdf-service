#!/usr/bin/env bun
/**
 * Showcase document — one PDF that exercises most of the library:
 * cover page, multi-column grids, CSS-only charts, a data table with totals,
 * code blocks, running header/footer and PDF outline.
 *
 * Run: bun run examples/showcase/render.ts
 */

import { launchBrowser, loadTemplate, multiply, formatCurrency } from "../../src/index.ts";

const dir = import.meta.dir;
const outDir = `${dir}/../outputs`;
await Bun.$`mkdir -p ${outDir}`.quiet();

const data = (await Bun.file(`${dir}/data.json`).json()) as any;

/* Business logic stays in TypeScript: templates format, they do not compute. */
const rawOrders = [
  { code: "HD-2026-0041", customer: "Công ty CP Sao Việt", day: "2026-10-02", value: 48_000_000, rate: 10, status: "Đã thu" },
  { code: "HD-2026-0042", customer: "Công ty TNHH Phạm Gia", day: "2026-10-23", value: 116_700_000, rate: 10, status: "Đã phát hành" },
  { code: "HD-2026-0043", customer: "Ngân hàng Đông Á", day: "2026-10-11", value: 92_500_000, rate: 8, status: "Đã thu" },
  { code: "HD-2026-0044", customer: "Công ty CP Bình Minh", day: "2026-10-16", value: 34_800_000, rate: 10, status: "Chờ thu" },
  { code: "HD-2026-0045", customer: "Trường ĐH Bách Khoa", day: "2026-10-19", value: 155_000_000, rate: 5, status: "Đã thu" },
  { code: "HD-2026-0046", customer: "Công ty TNHH An Phát", day: "2026-10-21", value: 27_600_000, rate: 10, status: "Quá hạn" },
];

const statusClass: Record<string, string> = {
  "Đã thu": "ok",
  "Đã phát hành": "info",
  "Chờ thu": "info",
  "Quá hạn": "warn",
};

const orders = rawOrders.map((order) => {
  const vat = Math.round((order.value * order.rate) / 100);
  return {
    ...order,
    vat,
    total: order.value + vat,
    statusClass: statusClass[order.status] ?? "info",
  };
});

const sum = (key: string) => orders.reduce((total, order) => total + (order as any)[key], 0);

/* Every number printed in the document is derived here, so the KPI row, the
   chart and the table can never disagree with each other. */
const bars = data.bars as Array<{ label: string; short: string; pct: number }>;
const revenueMonths = bars.map((bar) => Number(bar.short) * 1_000_000);
const revenueSixMonths = revenueMonths.reduce((total, value) => total + value, 0);
const peakValue = Math.max(...revenueMonths);
const peakLabel = bars[revenueMonths.indexOf(peakValue)]!.label;

const ordersCount = data.ordersCount as number;
const avgOrder = Math.round(revenueSixMonths / ordersCount);
const lastMonth = revenueMonths[revenueMonths.length - 1]!;
const prevMonth = revenueMonths[revenueMonths.length - 2]!;
const momGrowth = ((lastMonth - prevMonth) / prevMonth) * 100;

// Bars are drawn relative to the peak, recomputed rather than hardcoded.
const chartBars = bars.map((bar) => ({
  ...bar,
  pct: Math.round((Number(bar.short) * 1_000_000 / peakValue) * 100),
}));

const kpis = [
  {
    label: "Doanh thu 6 tháng",
    value: formatCurrency(revenueSixMonths, "VND"),
    delta: `+${momGrowth.toFixed(1).replace(".", ",")}% so với tháng trước`,
    up: momGrowth > 0,
  },
  {
    label: "Đơn hàng",
    value: new Intl.NumberFormat("vi-VN").format(ordersCount),
    delta: `${orders.length} đơn lớn nhất trong bảng`,
    up: true,
  },
  {
    label: "Giá trị TB / đơn",
    value: formatCurrency(avgOrder, "VND"),
    delta: "tính trên toàn kỳ",
    up: true,
  },
  {
    label: "Tỷ lệ hoàn",
    value: `${(data.refundRate as number).toFixed(1).replace(".", ",")}%`,
    delta: "thấp hơn ngưỡng 2%",
    up: true,
  },
];

const template = await loadTemplate(dir, { template: { strict: false } });

const browser = await launchBrowser();
const started = Date.now();

try {
  const result = await template.toPdf(
    {
      ...data,
      orders,
      kpis,
      bars: chartBars,
      peakShort: `${bars[revenueMonths.indexOf(peakValue)]!.short} triệu`,
      donutTotal: `${Math.round(revenueSixMonths / 1_000_000)}tr`,
      sumValue: sum("value"),
      sumVat: sum("vat"),
      sumTotal: sum("total"),
      // Code sample in the template is data, not markup: keeps the template free
      // of escaped braces that would confuse the parser.
      itemsBlock: [
        "{{#items}}",
        '  <td>{{currency (multiply quantity',
        '     unitPrice 0) "VND"}}</td>',
        "{{/items}}",
        "",
        "{{{htmlBlock}}}",
      ].join("\n"),
    },
    {
      browser,
      format: "A4",
      title: "pdf-service — tài liệu mẫu",
      outline: true,
      header: `
        <div style="width:100%;padding:0 16mm;font:7pt 'Helvetica Neue',Arial;color:#94a3b8;display:flex;justify-content:space-between;align-items:center">
          <span style="letter-spacing:0.12em;text-transform:uppercase">pdf-service · tài liệu mẫu</span>
          <span>v${data.meta.version}</span>
        </div>`,
      footer: `
        <div style="width:100%;padding:0 16mm;font:7pt 'Helvetica Neue',Arial;color:#94a3b8;display:flex;justify-content:space-between;align-items:center">
          <span>Nguyên Phạm · 23/10/2026</span>
          <span>Trang <span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>`,
      headerFooterMargin: 0.32,
    },
  );

  const path = `${outDir}/pdf-service-showcase.pdf`;
  await Bun.write(path, result.bytes);

  const kb = (result.bytes.byteLength / 1024).toFixed(1);
  console.log(`✔ ${path}`);
  console.log(`  ${result.pageCount} trang · ${kb} KB · ${Date.now() - started}ms`);
  console.log(`  load ${result.timings.loadMs}ms · print ${result.timings.printMs}ms`);

  console.log(
    `  doanh thu 6 tháng ${formatCurrency(revenueSixMonths, "VND")} · ` +
      `bảng ${formatCurrency(sum("total"), "VND")} (${orders.length} dòng)`,
  );
  console.log(`  cao nhất ${peakLabel} ${formatCurrency(peakValue, "VND")} · TB/đơn ${formatCurrency(avgOrder, "VND")}`);
} finally {
  await browser.close();
}
