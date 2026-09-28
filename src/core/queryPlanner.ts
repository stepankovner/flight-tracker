import { PLANNER } from '../config.ts';
import {
  addDays,
  addMonths,
  daysBetween,
  diffDays,
  maxDate,
  minDate,
  monthEnd,
  monthOf,
  monthStart,
  monthsBetween,
} from './dates.ts';
import { err, ok, type FareQuery, type IsoDate, type Result, type WatchSpec } from './types.ts';

export interface PlanOptions {
  currency: string;
  market: string;
}

export interface PlanError {
  code: 'window_passed' | 'no_pairs' | 'no_return_dates' | 'too_many_queries' | 'invalid';
  message: string;
  queries?: number;
}

/** Нормализованный ключ запроса — одинаковые запросы разных watch выполняются один раз за тик. */
export function queryKey(q: FareQuery): string {
  return [
    'pfd',
    q.origin,
    q.destination,
    q.departureAt,
    q.returnAt ?? '-',
    q.oneWay ? 'ow' : 'rt',
    q.direct ? 'd' : 'a',
    q.currency.toLowerCase(),
    q.market.toLowerCase(),
  ].join('|');
}

/** Эффективное окно вылета с учётом «сегодня». null — окно целиком в прошлом. */
export function effectiveWindow(watch: Pick<WatchSpec, 'departFrom' | 'departTo'>, today: IsoDate) {
  const from = maxDate(watch.departFrom, today);
  if (from > watch.departTo) return null;
  return { from, to: watch.departTo };
}

interface Leg {
  departureAt: string;
  returnAt: string | null;
}

/** Варианты разворота окна для одной пары городов; выбирается самый дешёвый по числу запросов. */
function legsOneway(from: IsoDate, to: IsoDate): Leg[] {
  const months = monthsBetween(from, to).map((ym) => ({ departureAt: ym, returnAt: null }));
  const windowDays = diffDays(to, from) + 1;
  if (windowDays <= PLANNER.DAY_QUERY_MAX_WINDOW_DAYS) {
    const days = daysBetween(from, to).map((d) => ({ departureAt: d, returnAt: null }));
    // при равенстве — дни: точнее выдача
    if (days.length <= months.length) return days;
  }
  return months;
}

function returnRange(
  depFrom: IsoDate,
  depTo: IsoDate,
  nightsMin: number,
  nightsMax: number,
  returnTo: IsoDate | null,
): { from: IsoDate; to: IsoDate } | null {
  const from = addDays(depFrom, nightsMin);
  let to = addDays(depTo, nightsMax);
  if (returnTo) to = minDate(to, returnTo);
  return from <= to ? { from, to } : null;
}

function legsRoundtrip(
  from: IsoDate,
  to: IsoDate,
  nightsMin: number,
  nightsMax: number,
  returnTo: IsoDate | null,
): Leg[] {
  // месяц вылета × месяцы возврата, достижимые из дней этого месяца
  const monthPairs: Leg[] = [];
  for (const ym of monthsBetween(from, to)) {
    const a = maxDate(from, monthStart(ym));
    const b = minDate(to, monthEnd(ym));
    const r = returnRange(a, b, nightsMin, nightsMax, returnTo);
    if (!r) continue;
    for (const rym of monthsBetween(r.from, r.to)) monthPairs.push({ departureAt: ym, returnAt: rym });
  }

  const windowDays = diffDays(to, from) + 1;
  if (windowDays > PLANNER.DAY_QUERY_MAX_WINDOW_DAYS) return monthPairs;

  // короткое окно: день вылета × день возврата, либо день вылета × месяц возврата
  const dayPairs: Leg[] = [];
  const dayMonthPairs: Leg[] = [];
  for (const d of daysBetween(from, to)) {
    const r = returnRange(d, d, nightsMin, nightsMax, returnTo);
    if (!r) continue;
    for (const rd of daysBetween(r.from, r.to)) dayPairs.push({ departureAt: d, returnAt: rd });
    for (const rym of monthsBetween(r.from, r.to)) dayMonthPairs.push({ departureAt: d, returnAt: rym });
  }
  // при равенстве предпочитаем более точный вариант
  const candidates = [dayPairs, dayMonthPairs, monthPairs].filter((c) => c.length > 0);
  if (candidates.length === 0) return [];
  return candidates.reduce((best, c) => (c.length < best.length ? c : best));
}

/**
 * Разворачивает watch в минимальный набор запросов (гранулярность — месяц, точная фильтрация — локально).
 * Чистая функция: `today` — сегодняшняя дата пользователя.
 */
export function planQueries(watch: WatchSpec, today: IsoDate, opts: PlanOptions): Result<FareQuery[], PlanError> {
  const window = effectiveWindow(watch, today);
  if (!window) return err({ code: 'window_passed', message: 'Окно дат вылета уже прошло.' });

  const pairs: Array<[string, string]> = [];
  for (const o of watch.origins) {
    for (const d of watch.destinations) {
      if (o !== d) pairs.push([o, d]);
    }
  }
  if (pairs.length === 0) {
    return err({ code: 'no_pairs', message: 'Пункты вылета и назначения совпадают.' });
  }

  let legs: Leg[];
  if (watch.tripType === 'oneway') {
    legs = legsOneway(window.from, window.to);
  } else {
    const nMin = watch.nightsMin;
    const nMax = watch.nightsMax;
    if (nMin === null || nMax === null || nMin < 0 || nMax < nMin) {
      return err({ code: 'invalid', message: 'Для поездки туда-обратно нужно указать число ночей.' });
    }
    legs = legsRoundtrip(window.from, window.to, nMin, nMax, watch.returnTo);
    if (legs.length === 0) {
      return err({
        code: 'no_return_dates',
        message: 'С такими ночами и датой «вернуться не позже» не остаётся ни одной даты возврата.',
      });
    }
  }

  const total = pairs.length * legs.length;
  if (total > PLANNER.MAX_QUERIES_PER_WATCH) {
    return err({
      code: 'too_many_queries',
      queries: total,
      message:
        `Слишком широкое наблюдение: нужно ${total} запросов к API за проверку ` +
        `(максимум ${PLANNER.MAX_QUERIES_PER_WATCH}). Сузь даты или уменьши число городов.`,
    });
  }

  const queries: FareQuery[] = [];
  for (const [origin, destination] of pairs) {
    for (const leg of legs) {
      queries.push({
        origin,
        destination,
        departureAt: leg.departureAt,
        returnAt: leg.returnAt,
        oneWay: watch.tripType === 'oneway',
        direct: watch.directOnly,
        currency: opts.currency.toLowerCase(),
        market: opts.market.toLowerCase(),
      });
    }
  }
  return ok(queries);
}

/** Запросы для бутстрапа истории (grouped_prices): месяцы окна ± соседние, по каждой паре городов. */
export interface CalendarQuery {
  origin: string;
  destination: string;
  /** YYYY-MM */
  month: string;
  oneWay: boolean;
  direct: boolean;
  minTripDuration: number | null;
  maxTripDuration: number | null;
  currency: string;
  market: string;
}

export function planBootstrap(
  watch: WatchSpec,
  today: IsoDate,
  opts: PlanOptions & { neighborMonths: number; maxQueries: number },
): CalendarQuery[] {
  const window = effectiveWindow(watch, today);
  if (!window) return [];
  const windowMonths = monthsBetween(window.from, window.to);
  const todayMonth = monthOf(today);
  const extra: string[] = [];
  for (let i = 1; i <= opts.neighborMonths; i++) {
    const before = addMonths(windowMonths[0]!, -i);
    const after = addMonths(windowMonths[windowMonths.length - 1]!, i);
    if (before >= todayMonth) extra.push(before);
    extra.push(after);
  }
  // сначала месяцы самого окна, потом соседние
  const months = [...windowMonths, ...extra.filter((m) => !windowMonths.includes(m))];
  const out: CalendarQuery[] = [];
  for (const month of months) {
    for (const o of watch.origins) {
      for (const d of watch.destinations) {
        if (o === d) continue;
        out.push({
          origin: o,
          destination: d,
          month,
          oneWay: watch.tripType === 'oneway',
          direct: watch.directOnly,
          minTripDuration: watch.tripType === 'roundtrip' ? watch.nightsMin : null,
          maxTripDuration: watch.tripType === 'roundtrip' ? watch.nightsMax : null,
          currency: opts.currency.toLowerCase(),
          market: opts.market.toLowerCase(),
        });
      }
    }
  }
  return out.slice(0, opts.maxQueries);
}

export function calendarKey(q: CalendarQuery): string {
  return [
    'grp',
    q.origin,
    q.destination,
    q.month,
    q.oneWay ? 'ow' : 'rt',
    q.direct ? 'd' : 'a',
    q.minTripDuration ?? '-',
    q.maxTripDuration ?? '-',
    q.currency,
    q.market,
  ].join('|');
}
