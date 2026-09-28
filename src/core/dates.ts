import type { IsoDate, YearMonth } from './types.ts';

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function toUtcMs(date: IsoDate): number {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid ISO date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function makeDate(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** a − b в днях */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcMs(a) - toUtcMs(b)) / DAY_MS);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 1 = понедельник … 7 = воскресенье */
export function weekdayOf(date: IsoDate): number {
  const d = new Date(toUtcMs(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

export function monthOf(date: IsoDate): YearMonth {
  return date.slice(0, 7);
}

export function monthStart(ym: YearMonth): IsoDate {
  return `${ym}-01`;
}

export function monthEnd(ym: YearMonth): IsoDate {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return makeDate(y, m, daysInMonth(y, m));
}

export function addMonths(ym: YearMonth, n: number): YearMonth {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${pad2((idx % 12) + 1)}`;
}

/** Все месяцы, пересекающиеся с [from, to] (включительно). */
export function monthsBetween(from: IsoDate, to: IsoDate): YearMonth[] {
  if (from > to) return [];
  const out: YearMonth[] = [];
  const last = monthOf(to);
  for (let ym = monthOf(from); ym <= last; ym = addMonths(ym, 1)) out.push(ym);
  return out;
}

/** Все дни [from, to] включительно. */
export function daysBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const maxDate = (a: IsoDate, b: IsoDate): IsoDate => (a > b ? a : b);
export const minDate = (a: IsoDate, b: IsoDate): IsoDate => (a < b ? a : b);

// ---------- Часовые пояса (Intl доступен и в Workers, и в Node) ----------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  date: IsoDate;
  /** 'HH:MM' */
  time: string;
  /** минут от полуночи */
  minutes: number;
}

export function localParts(now: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(now)) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${pad2(hour)}:${pad2(minute)}`,
    minutes: hour * 60 + minute,
  };
}

/** Сегодняшняя дата в часовом поясе пользователя. */
export function todayIn(now: Date, tz: string): IsoDate {
  return localParts(now, tz).date;
}

/** Смещение пояса от UTC в минутах в момент `at` (Москва = +180). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const localAsUtc = toUtcMs(p.date) + p.minutes * 60_000 + at.getUTCSeconds() * 1000;
  return Math.round((localAsUtc - (at.getTime() - at.getUTCMilliseconds())) / 60_000);
}

/** UTC-момент начала локальных суток `date` в поясе `tz`. */
export function zonedDayStart(date: IsoDate, tz: string): Date {
  const guess = new Date(toUtcMs(date));
  const off1 = tzOffsetMinutes(guess, tz);
  const first = new Date(guess.getTime() - off1 * 60_000);
  const off2 = tzOffsetMinutes(first, tz);
  return off1 === off2 ? first : new Date(guess.getTime() - off2 * 60_000);
}

/** 'HH:MM' → минут от полуночи; null если формат неверный. */
export function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatHm(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`;
}

export function hoursBetween(fromIso: string, to: Date): number {
  return (to.getTime() - Date.parse(fromIso)) / 3_600_000;
}
