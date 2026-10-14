import { ValidationError } from "@mgpl-diagnostics/db-kit";

/**
 * Integer helpers. Money is integer paise; rates are basis points (1 bp = 0.01%) or GST percent.
 * Days are IST (Asia/Kolkata, UTC+5:30, no daylight saving) and written "YYYY-MM-DD".
 */

const IST_MS = 5.5 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** Rounds a ratio n / d to the nearest integer, halves away from zero. Exact for safe integers. */
export function divRound(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0) throw new ValidationError(`divRound needs safe integers (${n} / ${d})`);
  const q = Math.floor((2 * Math.abs(n) + d) / (2 * d));
  return n < 0 ? -q : q;
}

/** amount × bp / 10 000, rounded half away from zero. */
export const applyBp = (amountPaise: number, bp: number): number => divRound(amountPaise * bp, 10000);

/** Rounds paise to the nearest rupee, halves away from zero. */
export const roundToRupee = (paise: number): number => divRound(paise, 100) * 100;

/** "2026-10-14" for the IST calendar day of an instant. */
export function istDay(date: Date): string {
  return new Date(date.getTime() + IST_MS).toISOString().slice(0, 10);
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertDay(day: string): void {
  const m = DAY_RE.exec(day);
  if (!m || istDay(startOfDay(day, false)) !== day) throw new ValidationError(`Expected an IST day "YYYY-MM-DD", got "${day}"`);
}

function startOfDay(day: string, check = true): Date {
  if (check) assertDay(day);
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_MS);
}

/** 00:00:00.000 IST of a day. */
export const startOfIstDay = (day: string): Date => startOfDay(day);
/** 23:59:59.999 IST of a day: lock dates and day-end vouchers use it. */
export const endOfIstDay = (day: string): Date => new Date(startOfDay(day).getTime() + DAY_MS - 1);
/** The IST day `n` days after `day`. */
export const addDays = (day: string, n: number): string => istDay(new Date(startOfDay(day).getTime() + n * DAY_MS));
/** Whole days from `a` to `b` (IST days). */
export const daysBetween = (a: string, b: string): number => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);

/** "2026-10" → first and last instant of that month in IST. */
export function monthRange(period: string): { from: Date; to: Date; first: string; last: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new ValidationError(`Expected a month "YYYY-MM", got "${period}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const first = `${period}-01`;
  const last = istDay(new Date(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) - IST_MS - 1));
  return { from: startOfIstDay(first), to: endOfIstDay(last), first, last };
}

/** Indian financial year "2025-26" → 1 Apr 2025 00:00 IST … 31 Mar 2026 23:59:59.999 IST. */
export function fyRange(fy: string): { from: Date; to: Date; first: string; last: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new ValidationError(`Expected a financial year like "2025-26", got "${fy}"`);
  const y = Number(m[1]);
  const first = `${y}-04-01`;
  const last = `${y + 1}-03-31`;
  return { from: startOfIstDay(first), to: endOfIstDay(last), first, last };
}

/** Financial year of an IST day or instant, e.g. "2026-27". */
export function fyOf(date: Date | string): string {
  const day = typeof date === "string" ? date : istDay(date);
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function assertPaise(value: number, what: string, { allowNegative = false } = {}): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) throw new ValidationError(`${what} must be whole paise${allowNegative ? "" : " (0 or more)"}: ${value}`);
}

export const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
