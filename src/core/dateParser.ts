import { PLANNER } from '../config.ts';
import {
  addDays,
  daysInMonth,
  isIsoDate,
  makeDate,
  maxDate,
  minDate,
  monthEnd,
  monthStart,
  parseHm,
} from './dates.ts';
import { err, ok, type IsoDate, type Result } from './types.ts';

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
  /** Начало окна было в прошлом и сдвинуто на сегодня. */
  clamped: boolean;
  /** Конец окна дальше горизонта данных (~год) и обрезан. */
  truncated?: boolean;
}

// ---------- Словарь месяцев ----------

/** Порядок важен: «мар» проверяем раньше «ма» (май/мая/мае). */
const MONTH_STEMS: Array<[string, number]> = [
  ['янв', 1], ['фев', 2], ['мар', 3], ['апр', 4], ['ма', 5], ['июн', 6], ['июл', 7],
  ['авг', 8], ['сен', 9], ['окт', 10], ['ноя', 11], ['дек', 12],
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6], ['jul', 7],
  ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
];

const MONTH_WORD = '([a-zа-я]{3,9})';

export function monthFromWord(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return null;
  for (const [stem, n] of MONTH_STEMS) {
    if (w.startsWith(stem)) {
      // «ма» — только май/мая/мае, а не случайные слова
      if (stem === 'ма' && !/^ма[йяе]$/.test(w)) continue;
      return n;
    }
  }
  return null;
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[–—−]/g, '-')
    .replace(/\+\/-|\+-|плюс[- ]?минус/g, '±')
    .replace(/\s+/g, ' ')
    .replace(/[,;]+$/g, '')
    .trim();
}

// ---------- Разбор отдельной даты ----------

interface PartialDate {
  day: number;
  month: number;
  year: number | null;
}

const NUM_DATE = String.raw`(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?`;
const WORD_DATE = String.raw`(\d{1,2}) ${MONTH_WORD}(?: (\d{4}))?`;

function yearFrom(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  return s.length === 2 ? 2000 + n : n;
}

function parseSingle(s: string): PartialDate | null {
  let m = new RegExp(`^${NUM_DATE}$`).exec(s);
  if (m) return { day: Number(m[1]), month: Number(m[2]), year: yearFrom(m[3]) };
  m = new RegExp(`^${WORD_DATE}$`).exec(s);
  if (m) {
    const month = monthFromWord(m[2]!);
    if (month === null) return null;
    return { day: Number(m[1]), month, year: yearFrom(m[3]) };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { day: Number(m[3]), month: Number(m[2]), year: Number(m[1]) };
  return null;
}

function validDayMonth(p: PartialDate): boolean {
  if (p.month < 1 || p.month > 12 || p.day < 1) return false;
  // 29.02 без года допустим — проверим после выбора года
  return p.day <= daysInMonth(p.year ?? 2024, p.month);
}

function currentYear(today: IsoDate): number {
  return Number(today.slice(0, 4));
}

/** Ближайший будущий год, в котором дата ≥ minDate. */
function resolveNearest(p: PartialDate, minDateInclusive: IsoDate): IsoDate | null {
  if (p.year !== null) {
    const d = makeDate(p.year, p.month, p.day);
    return isIsoDate(d) ? d : null;
  }
  const y0 = currentYear(minDateInclusive);
  for (let y = y0; y <= y0 + 4; y++) {
    const d = makeDate(y, p.month, p.day);
    if (isIsoDate(d) && d >= minDateInclusive) return d;
  }
  return null;
}

/** Та же дата в году, ближайшем «назад» от anchor (from ≤ anchor). */
function resolveBefore(p: PartialDate, anchor: IsoDate): IsoDate | null {
  if (p.year !== null) {
    const d = makeDate(p.year, p.month, p.day);
    return isIsoDate(d) ? d : null;
  }
  const y0 = currentYear(anchor);
  for (let y = y0; y >= y0 - 4; y--) {
    const d = makeDate(y, p.month, p.day);
    if (isIsoDate(d) && d <= anchor) return d;
  }
  return null;
}

// ---------- Финальная валидация ----------

function finish(from: IsoDate, to: IsoDate, today: IsoDate): Result<DateRange> {
  if (from > to) return err('Начало окна позже конца. Пример: 15.11-30.11');
  if (to < today) return err('Эти даты уже прошли. Укажи будущие даты.');
  const limit = addDays(today, PLANNER.MAX_DAYS_AHEAD);
  if (from > limit) {
    return err('Слишком далеко: у Aviasales есть цены максимум примерно на год вперёд.');
  }
  const clampedFrom = maxDate(from, today);
  const range: DateRange = { from: clampedFrom, to: minDate(to, limit), clamped: clampedFrom !== from };
  if (to > limit) range.truncated = true;
  return ok(range);
}

// ---------- Публичный парсер ----------

const HELP =
  'Не понял даты. Примеры: 15.11-30.11 · 15.11.2026-02.12.2026 · ноябрь · ноябрь-декабрь · 15.11 · ±3 от 20.11';

/**
 * Парсит окно дат вылета. Год подставляется ближайший будущий.
 * Форматы: `15.11-30.11`, `15.11.2026-02.12.2026`, `15-30.11`, `15-30 ноября`, `15 ноября - 2 декабря`,
 * `ноябрь`, `ноябрь 2026`, `ноябрь-декабрь`, `15.11`, `±3 от 20.11`, `20.11 ±3`, `2026-11-15`.
 */
export function parseDateRange(input: string, today: IsoDate): Result<DateRange> {
  const s = normalize(input).replace(/^(с|c|from) /, '').replace(/^в /, '');
  if (!s) return err(HELP);

  // ±N от DATE  |  DATE ±N
  let m = /^±\s?(\d{1,2})(?: ?(?:дн(?:я|ей|ь)?|д\.?|days?))?(?: (?:от|вокруг|около|к))? (.+)$/.exec(s);
  let center: string | undefined;
  let spread: number | undefined;
  if (m) {
    spread = Number(m[1]);
    center = m[2]!;
  } else {
    m = /^(.+?) ?± ?(\d{1,2})(?: ?(?:дн(?:я|ей|ь)?|д\.?|days?))?$/.exec(s);
    if (m) {
      center = m[1]!;
      spread = Number(m[2]);
    }
  }
  if (center !== undefined && spread !== undefined) {
    const p = parseSingle(center.trim());
    if (!p || !validDayMonth(p)) return err(HELP);
    if (spread > 30) return err('Слишком большой разброс: максимум ±30 дней.');
    const c = resolveNearest(p, addDays(today, -spread));
    if (!c) return err(HELP);
    return finish(addDays(c, -spread), addDays(c, spread), today);
  }

  // ISO-дата: 2026-11-15
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (!isIsoDate(s)) return err(HELP);
    return finish(s, s, today);
  }

  // ISO-диапазон: 2026-11-15 - 2026-11-30 / 2026-11-15..2026-11-30
  m = /^(\d{4}-\d{2}-\d{2}) ?(?:-|\.\.|по|до) ?(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (m) {
    if (!isIsoDate(m[1]!) || !isIsoDate(m[2]!)) return err(HELP);
    return finish(m[1]!, m[2]!, today);
  }

  // Диапазон дат: A - B, где A может быть только днём (15-30.11, 15-30 ноября)
  const rangeParts = splitRange(s);
  if (rangeParts) {
    const [left, right] = rangeParts;
    const end = parseSingle(right);
    if (end && validDayMonth(end)) {
      let start = parseSingle(left);
      if (!start && /^\d{1,2}$/.test(left)) {
        start = { day: Number(left), month: end.month, year: end.year };
      }
      if (start && validDayMonth(start)) {
        const to = resolveNearest(end, today);
        if (!to) return err(HELP);
        const from = resolveBefore(start, to);
        if (!from) return err(HELP);
        return finish(from, to, today);
      }
    }
    // Диапазон месяцев: ноябрь-декабрь, ноябрь 2026 - январь 2027
    const mLeft = parseMonth(left);
    const mRight = parseMonth(right);
    if (mLeft && mRight) {
      const endYm = resolveMonth(mRight, today);
      const endYear = Number(endYm.slice(0, 4));
      const startYear = mLeft.year ?? (mLeft.month <= mRight.month ? endYear : endYear - 1);
      const from = monthStart(`${startYear}-${String(mLeft.month).padStart(2, '0')}`);
      return finish(from, monthEnd(endYm), today);
    }
    return err(HELP);
  }

  // Одна дата
  const single = parseSingle(s);
  if (single) {
    if (!validDayMonth(single)) return err(HELP);
    const d = resolveNearest(single, today);
    if (!d) return err(HELP);
    return finish(d, d, today);
  }

  // Один месяц
  const month = parseMonth(s);
  if (month) {
    const ym = resolveMonth(month, today);
    return finish(monthStart(ym), monthEnd(ym), today);
  }

  return err(HELP);
}

function splitRange(s: string): [string, string] | null {
  const m = /^(.+?) ?(?:-|\.\.| по | до ) ?(.+)$/.exec(s);
  if (!m) return null;
  return [m[1]!.trim(), m[2]!.trim()];
}

function parseMonth(s: string): { month: number; year: number | null } | null {
  const m = new RegExp(`^${MONTH_WORD}(?: (\\d{4}))?$`).exec(s.trim());
  if (!m) return null;
  const month = monthFromWord(m[1]!);
  if (month === null) return null;
  return { month, year: m[2] ? Number(m[2]) : null };
}

function resolveMonth(p: { month: number; year: number | null }, today: IsoDate): string {
  const mm = String(p.month).padStart(2, '0');
  if (p.year !== null) return `${p.year}-${mm}`;
  const y = currentYear(today);
  const thisYear = `${y}-${mm}`;
  return monthEnd(thisYear) >= today ? thisYear : `${y + 1}-${mm}`;
}

// ---------- Прочие парсеры ввода ----------

export interface NightsRange {
  min: number;
  max: number;
}

export function parseNights(input: string): Result<NightsRange> {
  const s = normalize(input).replace(/ ?(ночей|ночи|ночь|nights?|дней|дня|день)$/, '');
  const m = /^(?:от )?(\d{1,2})(?: ?(?:-|\.\.|до) ?(\d{1,2}))?$/.exec(s);
  if (!m) return err('Не понял. Примеры: 7 · 5-9 · от 10 до 14');
  const min = Number(m[1]);
  const max = m[2] !== undefined ? Number(m[2]) : min;
  if (min < 1 || max > PLANNER.MAX_NIGHTS) return err(`Ночей должно быть от 1 до ${PLANNER.MAX_NIGHTS}.`);
  if (min > max) return err('Минимум ночей больше максимума.');
  return ok({ min, max });
}

/** «10000», «10 000», «10к», «10k», «10 тыс», «9 999 ₽» → целое число. */
export function parsePrice(input: string): Result<number> {
  let s = input
    .toLowerCase()
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/^(до|недороже|максимум|макс\.?|max)/, '')
    .replace(/₽|руб(лей|ля|ль)?\.?|р\.?$|rub/g, '');
  let mult = 1;
  const km = /^(\d+(?:[.,]\d+)?)(к|k|тыс\.?|т)$/.exec(s);
  if (km) {
    s = km[1]!.replace(',', '.');
    mult = 1000;
  }
  if (!/^\d+(?:[.,]\d+)?$/.test(s)) return err('Введи число, например 12000 или 12к.');
  const value = Math.round(Number(s.replace(',', '.')) * mult);
  if (!Number.isFinite(value) || value < 100) return err('Слишком маленькая цена (минимум 100).');
  if (value > 10_000_000) return err('Слишком большая цена.');
  return ok(value);
}

export interface TimeWindow {
  from: string;
  to: string;
}

/** «23:00-08:00», «23-8», «23.00-7.30» → окно; «выкл»/«нет»/«off» → null. */
export function parseTimeWindow(input: string): Result<TimeWindow | null> {
  const s = normalize(input);
  if (/^(выкл|откл|нет|off|no|-|0)$/.test(s)) return ok(null);
  const m = /^(\d{1,2})(?:[:.](\d{2}))? ?- ?(\d{1,2})(?:[:.](\d{2}))?$/.exec(s);
  if (!m) return err('Формат: 23:00-08:00 (или «выкл»).');
  const from = `${m[1]!.padStart(2, '0')}:${m[2] ?? '00'}`;
  const to = `${m[3]!.padStart(2, '0')}:${m[4] ?? '00'}`;
  if (parseHm(from) === null || parseHm(to) === null) return err('Часы 0–23, минуты 0–59.');
  if (from === to) return err('Начало и конец совпадают.');
  return ok({ from, to });
}
