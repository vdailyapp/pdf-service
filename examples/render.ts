#!/usr/bin/env bun
/**
 * Example runner — builds both sample PDFs into outputs/.
 *
 * Run: bun run examples/render.ts
 */

import {
  launchBrowser,
  loadTemplate,
  documentHelpers,
  multiply,
  formatCurrency,
  slugify,
} from "../src/index.ts";

const OUT = `${import.meta.dir}/outputs`;
await Bun.$`mkdir -p ${OUT}`.quiet();

const browser = await launchBrowser();
const started = Date.now();

try {
  /* ------------------------------------------------------------- invoice */
  const invoiceData = (await Bun.file(`${import.meta.dir}/invoice/data.json`).json()) as any;

  // Derived totals are computed in TypeScript, not in the template: business
  // rules belong in code you can test, not in string interpolation.
  const subtotal = invoiceData.items.reduce(
    (total: number, item: { quantity: number; unitPrice: number }) =>
      total + multiply(item.quantity, item.unitPrice, 0),
    0,
  );
  const discount = invoiceData.totals.discount ?? 0;
  const vat = Math.round(((subtotal - discount) * invoiceData.totals.vatRate) / 100);
  const grand = subtotal - discount + vat;

  const invoice = await loadTemplate(`${import.meta.dir}/invoice`, {
    template: { helpers: documentHelpers },
    tokens: { brand: "#1d4ed8" },
  });

  const invoiceResult = await invoice.toPdf(
    {
      ...invoiceData,
      totals: { ...invoiceData.totals, subtotal, vat, grand },
    },
    {
      browser,
      format: "A4",
      title: `Hoá đơn ${invoiceData.invoice.number}`,
      footer: `
        <div style="width:100%;padding:0 16mm;font:8pt 'Helvetica Neue',Arial;color:#98a2b3;display:flex;justify-content:space-between">
          <span>${invoiceData.seller.name} · ${invoiceData.seller.taxId}</span>
          <span>Trang <span class="pageNumber"></span>/<span class="totalPages"></span></span>
        </div>`,
      watermark: invoiceData.invoice.status === "Đã phát hành" ? undefined : "BẢN NHÁP",
    },
  );

  const invoicePath = `${OUT}/${slugify(invoiceData.invoice.number)}.pdf`;
  await Bun.write(invoicePath, invoiceResult.bytes);

  /* -------------------------------------------------------------- report */
  const report = await loadTemplate(`${import.meta.dir}/report`, {
    template: { helpers: documentHelpers },
  });

  const metrics = {
    revenue: [128_400_000, 141_900_000, 137_200_000, 158_600_000, 172_300_000, 189_100_000],
    months: ["Tháng 5", "Tháng 6", "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10"],
  };
  const peak = Math.max(...metrics.revenue);
  const series = metrics.revenue.map((value, index) => ({
    label: metrics.months[index],
    value,
    display: formatCurrency(value, "VND"),
    height: Math.round((value / peak) * 100),
    delta: index === 0 ? null : Math.round(((value - metrics.revenue[index - 1]!) / metrics.revenue[index - 1]!) * 1000) / 10,
  }));

  const reportResult = await report.toPdf(
    {
      title: "Báo cáo tăng trưởng Q3/2026",
      subtitle: "Doanh thu theo tháng, đã bao gồm VAT",
      author: "Phòng Phân tích",
      generatedAt: new Date().toISOString(),
      series,
      peak,
      highlights: [
        { label: "Doanh thu quý", value: formatCurrency(metrics.revenue.slice(3).reduce((a, b) => a + b, 0), "VND") },
        { label: "Tăng trưởng so với quý trước", value: "+21,4%" },
        { label: "Khách hàng mới", value: "37" },
      ],
      table: [
        { month: "Tháng 8", revenue: 158_600_000, orders: 412, refundRate: 1.2 },
        { month: "Tháng 9", revenue: 172_300_000, orders: 468, refundRate: 0.9 },
        { month: "Tháng 10", revenue: 189_100_000, orders: 503, refundRate: 1.4 },
      ],
    },
    {
      browser,
      format: "A4",
      title: "Báo cáo tăng trưởng Q3/2026",
      header: `
        <div style="width:100%;padding:0 16mm;font:7.5pt 'Helvetica Neue',Arial;color:#98a2b3;display:flex;justify-content:space-between">
          <span>Báo cáo tăng trưởng Q3/2026</span>
          <span>Phòng Phân tích</span>
        </div>`,
      footer: `
        <div style="width:100%;padding:0 16mm;font:7.5pt 'Helvetica Neue',Arial;color:#98a2b3;text-align:center">
          Trang <span class="pageNumber"></span> / <span class="totalPages"></span>
        </div>`,
      outline: true,
    },
  );

  const reportPath = `${OUT}/bao-cao-q3-2026.pdf`;
  await Bun.write(reportPath, reportResult.bytes);

  /* ------------------------------------------------------------- summary */
  console.log("");
  for (const [label, path, result] of [
    ["Hoá đơn", invoicePath, invoiceResult],
    ["Báo cáo", reportPath, reportResult],
  ] as const) {
    const kb = (result.bytes.byteLength / 1024).toFixed(1);
    console.log(
      `✔ ${label.padEnd(8)} ${result.pageCount} trang  ${kb.padStart(7)} KB  ${path}`,
    );
    console.log(
      `           load ${result.timings.loadMs}ms · print ${result.timings.printMs}ms`,
    );
  }
  console.log(`\nTổng: ${Date.now() - started}ms (dùng chung 1 browser)`);
} finally {
  await browser.close();
}
