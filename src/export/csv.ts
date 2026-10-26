/**
 * CSV for the CA: RFC 4180 (CRLF, quoted when needed), UTF-8. Amounts are rupees with two decimals
 * written from integer paise (no floats); dates are IST days "YYYY-MM-DD". Our own formats, no Tally XML.
 */

export type Cell = string | number | null | undefined;

/**
 * A text cell starting with = + - @ (or tab / CR) is a formula to Excel and LibreOffice: a ledger name or
 * narration like `=HYPERLINK(...)` would run on the CA's machine (CSV injection, CWE-1236). Such cells get
 * a leading `'` so they open as text. Plain numbers (negative amounts from `rupees()`) are left alone.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;
const defuse = (s: string): string => (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s);

const quote = (v: Cell): string => {
  const s = v === null || v === undefined ? "" : typeof v === "number" ? String(v) : defuse(String(v));
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Rows → CSV text. Pass `bom: true` for Excel on Windows to read UTF-8. */
export function toCsv(header: string[], rows: Cell[][], opts: { bom?: boolean } = {}): string {
  const text = [header, ...rows].map((r) => r.map(quote).join(",")).join("\r\n") + "\r\n";
  return opts.bom ? `﻿${text}` : text;
}

/** 123456 → "1234.56", -5 → "-0.05". Empty for 0 when `blankZero`. */
export function rupees(paise: number, blankZero = false): string {
  if (blankZero && paise === 0) return "";
  const sign = paise < 0 ? "-" : "";
  const a = Math.abs(paise);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** GST rate for display: 18 → "18", 0.25 → "0.25". */
export const ratePct = (r: number) => String(r);
