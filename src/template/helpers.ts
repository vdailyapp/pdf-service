/**
 * Formatting helpers for document templates.
 *
 * Deliberately locale-explicit: Vietnamese documents want `1.234.567 ₫` and
 * `23/10/2026`, while the same library ships English invoices. Nothing is
 * inferred from the host machine's locale.
 */

import type { Helper } from "./engine.ts";

export type NumberFormatOptions = {
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

/** `1234567.891` -> `"1.234.567,89"` (vi) or `"1,234,567.89"` (en). */
export function formatNumber(value: unknown, options: NumberFormatOptions = {}): string {
  const num = toNumber(value);
  if (num === null) return "";
  return new Intl.NumberFormat(options.locale ?? "en-US", {
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(num);
}

export function formatCurrency(value: unknown, currency = "VND", locale = "vi-VN"): string {
  const num = toNumber(value);
  if (num === null) return "";

  // VND has no minor unit; Intl already handles that, but we keep the symbol
  // placement stable for documents that mix currencies.
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "symbol",
      maximumFractionDigits: currency === "VND" ? 0 : 2,
    }).format(num);
  } catch {
    return `${formatNumber(num, { locale })} ${currency}`;
  }
}

/** `2026-10-23` or Date -> `23/10/2026`. Pass `"iso"` for `2026-10-23`. */
export function formatDate(value: unknown, format: "dmy" | "iso" | "long" = "dmy", locale = "vi-VN"): string {
  const date = toDate(value);
  if (!date) return "";
  if (format === "iso") return date.toISOString().slice(0, 10);
  if (format === "long") {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
  }
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

/** Uppercase ASCII-ish slug used for file names: "Hoá đơn 01" -> "hoa-don-01". */
export function slugify(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Multiply and round — invoice line totals without float dust. */
export function multiply(a: unknown, b: unknown, decimals = 2): number {
  const x = toNumber(a) ?? 0;
  const y = toNumber(b) ?? 0;
  const factor = 10 ** decimals;
  return Math.round(x * y * factor) / factor;
}

/** Sum a numeric array or an array of objects with a numeric key. */
export function sumBy(items: unknown, key?: string): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce<number>((total, item) => {
    const raw = key && typeof item === "object" && item !== null ? (item as any)[key] : item;
    const num = toNumber(raw);
    return num === null ? total : total + num;
  }, 0);
}

export function percentOf(value: unknown, percent: unknown, decimals = 2): number {
  return multiply(value, (toNumber(percent) ?? 0) / 100, decimals);
}

/** Vietnamese amount in words, for invoices that require it. */
export function numberToVietnameseWords(value: unknown): string {
  const num = toNumber(value);
  if (num === null) return "";
  if (!Number.isInteger(num)) {
    return numberToVietnameseWords(Math.round(num));
  }
  if (num === 0) return "Không đồng";

  const digits = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];
  const groups = ["", " nghìn", " triệu", " tỷ", " nghìn tỷ", " triệu tỷ"];

  const readGroup = (group: number, forceHundreds: boolean): string => {
    const hundred = Math.floor(group / 100);
    const ten = Math.floor((group % 100) / 10);
    const unit = group % 10;
    const parts: string[] = [];

    if (hundred > 0 || forceHundreds) parts.push(`${digits[hundred]} trăm`);

    if (ten > 1) {
      parts.push(`${digits[ten]} mươi`);
      if (unit === 1) parts.push("mốt");
      else if (unit === 5) parts.push("lăm");
      else if (unit > 0) parts.push(digits[unit]);
    } else if (ten === 1) {
      parts.push("mười");
      if (unit === 5) parts.push("lăm");
      else if (unit > 0) parts.push(digits[unit]);
    } else if (unit > 0) {
      if (hundred > 0 || forceHundreds) parts.push("lẻ");
      parts.push(digits[unit]);
    }

    return parts.join(" ");
  };

  const chunks: number[] = [];
  let rest = num;
  while (rest > 0) {
    chunks.unshift(rest % 1000);
    rest = Math.floor(rest / 1000);
  }

  const words: string[] = [];
  chunks.forEach((chunk, index) => {
    if (chunk === 0) return;
    const position = chunks.length - index - 1;
    words.push(readGroup(chunk, index > 0) + (groups[position] ?? ""));
  });

  const text = words.join(" ").replace(/\s+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1) + " đồng";
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    // Treat bare `YYYY-MM-DD` as local midnight so dates don't shift a day.
    const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (bare) return new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Helper registry consumable by the template engine. */
export const documentHelpers: Record<string, Helper> = {
  currency: (value, args) =>
    formatCurrency(
      value,
      typeof args[0] === "string" ? args[0] : "VND",
      typeof args[1] === "string" ? args[1] : "vi-VN",
    ),
  number: (value, args) =>
    formatNumber(value, {
      locale: typeof args[1] === "string" ? args[1] : "en-US",
      minimumFractionDigits: typeof args[0] === "number" ? args[0] : 0,
      maximumFractionDigits: typeof args[0] === "number" ? args[0] : 2,
    }),
  date: (value, args) =>
    formatDate(
      value,
      (args[0] as "dmy" | "iso" | "long") ?? "dmy",
      typeof args[1] === "string" ? args[1] : "vi-VN",
    ),
  slug: (value) => slugify(value),
  multiply: (value, args) => multiply(value, args[0], typeof args[1] === "number" ? args[1] : 2),
  sum: (value, args) => sumBy(value, typeof args[0] === "string" ? args[0] : undefined),
  percent: (value, args) => percentOf(value, args[0], typeof args[1] === "number" ? args[1] : 2),
  words: (value) => numberToVietnameseWords(value),
  pad: (value, args) => {
    const width = typeof args[0] === "number" ? args[0] : 2;
    const fill = typeof args[1] === "string" ? args[1] : "0";
    return String(value ?? "").padStart(width, fill);
  },
  eq: (value, args) => String(value ?? "") === String(args[0] ?? ""),
  gt: (value, args) => (toNumber(value) ?? 0) > (toNumber(args[0]) ?? 0),
};
