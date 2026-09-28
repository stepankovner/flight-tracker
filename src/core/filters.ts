import { FILTERS } from '../config.ts';
import { diffDays, isIsoDate, parseHm, weekdayOf } from './dates.ts';
import type { IsoDate, Offer, WatchSpec } from './types.ts';

export type RejectReason =
  | 'bad_data'
  | 'too_soon'
  | 'expired'
  | 'depart_window'
  | 'trip_type'
  | 'nights'
  | 'return_to'
  | 'depart_weekday'
  | 'return_weekday'
  | 'transfers'
  | 'duration'
  | 'airline'
  | 'depart_time'
  | 'route';

/** Локальная дата из ISO-строки с offset: '2026-11-12T06:40:00+03:00' → '2026-11-12'. */
export function localDateOf(iso: string): IsoDate {
  return iso.slice(0, 10);
}

/** Локальное время 'HH:MM' из ISO-строки с offset (без пересчёта в UTC). */
export function localTimeOf(iso: string): string | null {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : null;
}

export function nightsOf(offer: Offer): number | null {
  if (!offer.returnAt) return null;
  return diffDays(localDateOf(offer.returnAt), localDateOf(offer.departAt));
}

/** Окно времени вылета; поддерживает окна через полночь (22:00–02:00). */
export function inTimeWindow(time: string, from: string | null, to: string | null): boolean {
  const t = parseHm(time);
  if (t === null) return true;
  const f = from ? parseHm(from) : null;
  const e = to ? parseHm(to) : null;
  if (f === null && e === null) return true;
  if (f !== null && e === null) return t >= f;
  if (f === null && e !== null) return t <= e;
  return f! <= e! ? t >= f! && t <= e! : t >= f! || t <= e!;
}

/**
 * Возвращает null, если оффер подходит под watch, иначе — причину отказа.
 * `now` — текущий момент (для «не в прошлом и не раньше чем через 3 ч»).
 */
export function rejectReason(offer: Offer, watch: WatchSpec, now: Date): RejectReason | null {
  const departDate = localDateOf(offer.departAt);
  const departMs = Date.parse(offer.departAt);
  if (!isIsoDate(departDate) || Number.isNaN(departMs) || !(offer.price > 0)) return 'bad_data';

  if (departMs < now.getTime() + FILTERS.MIN_HOURS_BEFORE_DEPARTURE * 3_600_000) return 'too_soon';
  if (offer.expiresAt && Date.parse(offer.expiresAt) < now.getTime()) return 'expired';

  if (departDate < watch.departFrom || departDate > watch.departTo) return 'depart_window';

  if (watch.tripType === 'oneway') {
    if (offer.returnAt) return 'trip_type';
  } else {
    if (!offer.returnAt) return 'trip_type';
    const returnDate = localDateOf(offer.returnAt);
    if (!isIsoDate(returnDate)) return 'bad_data';
    const nights = diffDays(returnDate, departDate);
    if (nights < 0) return 'bad_data';
    if (watch.nightsMin !== null && nights < watch.nightsMin) return 'nights';
    if (watch.nightsMax !== null && nights > watch.nightsMax) return 'nights';
    if (watch.returnTo && returnDate > watch.returnTo) return 'return_to';
    if (watch.returnWeekdays?.length && !watch.returnWeekdays.includes(weekdayOf(returnDate))) {
      return 'return_weekday';
    }
  }

  if (watch.departWeekdays?.length && !watch.departWeekdays.includes(weekdayOf(departDate))) {
    return 'depart_weekday';
  }

  // пересадки — и туда, и обратно
  const maxTransfers = watch.directOnly ? 0 : watch.maxTransfers;
  if (maxTransfers !== null) {
    if (offer.transfersOut > maxTransfers) return 'transfers';
    if (watch.tripType === 'roundtrip' && offer.transfersBack !== null && offer.transfersBack > maxTransfers) {
      return 'transfers';
    }
  }

  // длительность — каждого направления
  if (watch.maxDurationMin !== null) {
    const legs =
      offer.durationOutMin !== null || offer.durationBackMin !== null
        ? [offer.durationOutMin, offer.durationBackMin]
        : [watch.tripType === 'oneway' ? offer.durationMin : null];
    if (legs.some((d) => d !== null && d > watch.maxDurationMin!)) return 'duration';
  }

  if (watch.excludeAirlines?.length && watch.excludeAirlines.includes(offer.airline.toUpperCase())) {
    return 'airline';
  }

  if (watch.departTimeFrom || watch.departTimeTo) {
    const t = localTimeOf(offer.departAt);
    if (t && !inTimeWindow(t, watch.departTimeFrom, watch.departTimeTo)) return 'depart_time';
  }

  return null;
}

export function matchesWatch(offer: Offer, watch: WatchSpec, now: Date): boolean {
  return rejectReason(offer, watch, now) === null;
}

/** Ключ оффера для дедупликации (SPEC §7). */
export function offerKey(o: Offer): string {
  return [
    o.originAirport,
    o.destAirport,
    localDateOf(o.departAt),
    o.returnAt ? localDateOf(o.returnAt) : '',
    o.airline,
    o.flightNumber,
  ].join('|');
}

/** Отфильтровать, убрать дубли по offer_key (оставив дешёвый) и отсортировать по цене. */
export function selectMatching(offers: Offer[], watch: WatchSpec, now: Date): Offer[] {
  const best = new Map<string, Offer>();
  for (const o of offers) {
    if (!matchesWatch(o, watch, now)) continue;
    const k = offerKey(o);
    const prev = best.get(k);
    if (!prev || o.price < prev.price) best.set(k, o);
  }
  return [...best.values()].sort((a, b) => a.price - b.price || a.departAt.localeCompare(b.departAt));
}
