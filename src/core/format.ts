import { DETECTOR } from '../config.ts';
import { diffDays, weekdayOf } from './dates.ts';
import { localDateOf, localTimeOf, nightsOf } from './filters.ts';
import { buildBuyLink, searchDateFromLink } from './links.ts';
import type { PriceStats, Reason } from './priceDetector.ts';
import type { IsoDate, Offer, WatchSpec } from './types.ts';

// ---------- Базовые утилиты ----------

const NBSP = '\u00a0';
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const CURRENCY_SIGNS: Record<string, string> = {
  rub: '₽', usd: '$', eur: '€', kzt: '₸', uah: '₴', try: '₺', byn: 'Br', gbp: '£', uzs: 'сум', amd: '֏', gel: '₾',
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function fmtNumber(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

export function fmtPrice(n: number, currency = 'rub'): string {
  return `${fmtNumber(n)}${NBSP}${CURRENCY_SIGNS[currency.toLowerCase()] ?? currency.toUpperCase()}`;
}

/** '2026-11-12' → '12 ноя (чт)' */
export function fmtDate(d: IsoDate, withWeekday = true): string {
  const day = Number(d.slice(8, 10));
  const mon = MONTHS_SHORT[Number(d.slice(5, 7)) - 1];
  return withWeekday ? `${day} ${mon} (${WEEKDAYS_SHORT[weekdayOf(d) - 1]})` : `${day} ${mon}`;
}

/** '2026-11-12' → '12 ноя 2026' */
export function fmtDateYear(d: IsoDate): string {
  return `${fmtDate(d, false)} ${d.slice(0, 4)}`;
}

export function fmtDateRange(from: IsoDate, to: IsoDate): string {
  if (from === to) return fmtDateYear(from);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${fmtDate(from, false)} – ${fmtDateYear(to)}`;
  return `${fmtDateYear(from)} – ${fmtDateYear(to)}`;
}

/** ISO с offset → '12 ноя (чт) 06:40' (локальное время аэропорта) */
export function fmtDateTime(iso: string): string {
  const t = localTimeOf(iso);
  return t ? `${fmtDate(localDateOf(iso))} ${t}` : fmtDate(localDateOf(iso));
}

export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function fmtNights(n: number): string {
  return `${n} ${plural(n, ['ночь', 'ночи', 'ночей'])}`;
}

export function fmtTransfers(n: number): string {
  return n === 0 ? 'прямой' : `${n} ${plural(n, ['пересадка', 'пересадки', 'пересадок'])}`;
}

export function fmtWeekdays(days: number[]): string {
  return [...days].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d - 1]).join(', ');
}

// ---------- Справочник названий ----------

export interface PlaceName {
  kind: 'city' | 'airport';
  name: string;
  cityName: string | null;
}

export interface NameBook {
  places: Record<string, PlaceName>;
  airlines: Record<string, string>;
}

export const EMPTY_NAMES: NameBook = { places: {}, airlines: {} };

/** Город по коду города или аэропорта: 'Москва'. */
export function cityName(code: string, names: NameBook): string {
  const p = names.places[code];
  if (!p) return code;
  return p.kind === 'airport' ? (p.cityName ?? p.name) : p.name;
}

/** 'Москва (SVO)' */
export function airportLabel(code: string, names: NameBook): string {
  const p = names.places[code];
  return p ? `${escapeHtml(cityName(code, names))} (${code})` : code;
}

export function routeTitle(origins: string[], destinations: string[], names: NameBook): string {
  const o = origins.map((c) => escapeHtml(cityName(c, names))).join(', ');
  const d = destinations.map((c) => escapeHtml(cityName(c, names))).join(', ');
  return `${o} → ${d}`;
}

export function airlineLabel(offer: Offer, names: NameBook): string {
  const name = names.airlines[offer.airline];
  const flight = [offer.airline, offer.flightNumber].filter(Boolean).join(NBSP);
  return name ? `${escapeHtml(name)} ${flight}` : flight;
}

// ---------- Строки про оффер ----------

export function reasonText(r: Reason, currency: string): string {
  switch (r.kind) {
    case 'threshold':
      return r.pctBelow > 0
        ? `ниже твоего порога ${fmtPrice(r.maxPrice, currency)} на ${r.pctBelow}%`
        : `в пределах твоего порога ${fmtPrice(r.maxPrice, currency)}`;
    case 'auto':
      return r.confidence === 'high'
        ? `на ${r.pctBelow}% ниже медианы за ${r.windowDays} ${plural(r.windowDays, ['день', 'дня', 'дней'])} (${fmtPrice(r.baseline, currency)})`
        : `на ${r.pctBelow}% ниже типичной цены по календарю Aviasales (${fmtPrice(r.baseline, currency)}, оценка)`;
    case 'record':
      return `новый минимум — раньше не видел дешевле ${fmtPrice(r.previousMin, currency)} за ${r.historyDays} ${plural(r.historyDays, ['день', 'дня', 'дней'])}`;
  }
}

export function reasonsText(reasons: Reason[], currency: string): string {
  return reasons.map((r) => reasonText(r, currency)).join(' · ');
}

export function datesLine(offer: Offer): string {
  const dep = fmtDateTime(offer.departAt);
  if (!offer.returnAt) return dep;
  const n = nightsOf(offer);
  return `${dep} → ${fmtDateTime(offer.returnAt)}${n !== null ? `, ${fmtNights(n)}` : ''}`;
}

export function transfersLine(offer: Offer, names: NameBook): string {
  const parts: string[] = [];
  if (offer.returnAt && offer.transfersBack !== null) {
    parts.push(`${fmtTransfers(offer.transfersOut)} туда`, `${fmtTransfers(offer.transfersBack)} обратно`);
  } else {
    parts.push(fmtTransfers(offer.transfersOut));
  }
  const airline = airlineLabel(offer, names);
  if (airline) parts.push(airline);
  return parts.join(' · ');
}

export function durationLine(offer: Offer): string | null {
  if (offer.returnAt && offer.durationOutMin && offer.durationBackMin) {
    return `в пути ${fmtDuration(offer.durationOutMin)} туда · ${fmtDuration(offer.durationBackMin)} обратно`;
  }
  const d = offer.durationOutMin ?? (offer.returnAt ? null : offer.durationMin);
  return d ? `в пути ${fmtDuration(d)}` : null;
}

/** Сколько часов назад найдена цена (по found_at или search_date из ссылки). */
export function offerAgeHours(offer: Offer, now: Date): number | null {
  if (offer.foundAt) {
    const t = Date.parse(offer.foundAt);
    if (!Number.isNaN(t)) return Math.max(0, (now.getTime() - t) / 3_600_000);
  }
  return null;
}

/** «найдена ~3 ч назад» / «найдена сегодня» / «найдена вчера» / «найдена за последние 48 ч» */
export function ageText(offers: Offer[], now: Date, todayUtc: IsoDate): string {
  const hours = offers.map((o) => offerAgeHours(o, now)).filter((h): h is number => h !== null);
  if (hours.length === offers.length && hours.length > 0) {
    const h = Math.max(...hours);
    if (h < 1) return 'меньше часа назад';
    if (h < 48) return `~${Math.round(h)} ч назад`;
    return `~${Math.round(h / 24)} дн. назад`;
  }
  const dates = offers.map((o) => searchDateFromLink(o.link)).filter((d): d is string => d !== null);
  if (dates.length === offers.length && dates.length > 0) {
    const oldest = dates.sort()[0]!;
    const days = diffDays(todayUtc, oldest);
    if (days <= 0) return 'сегодня';
    if (days === 1) return 'вчера';
    return `${days} ${plural(days, ['день', 'дня', 'дней'])} назад`;
  }
  return 'за последние ~48 ч';
}

function cacheLine(offers: Offer[], now: Date): string {
  const found = ageText(offers, now, now.toISOString().slice(0, 10));
  const plural = offers.length > 1;
  return `🕒 ${plural ? 'Цены' : 'Цена'} из кэша Aviasales, ${plural ? 'найдены' : 'найдена'} ${found} — проверь перед покупкой`;
}

function adultsLine(price: number, adults: number, currency: string): string | null {
  if (adults <= 1) return null;
  return `👥 ≈ ${fmtPrice(price * adults, currency)} за ${adults} ${plural(adults, ['взрослого', 'взрослых', 'взрослых'])} (оценка)`;
}

// ---------- Клавиатуры (сырой формат Bot API) ----------

export type Button = { text: string; url: string } | { text: string; callback_data: string };
export type Keyboard = Button[][];

const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ---------- Уведомления ----------

export interface AlertOffer {
  offer: Offer;
  reasons: Reason[];
}

/** То, что лежит в outbox.payload для alert/reply. */
export interface AlertPayload {
  v: 1;
  mode: 'alert' | 'initial' | 'manual';
  watchId: number;
  origins: string[];
  destinations: string[];
  tripType: WatchSpec['tripType'];
  adults: number;
  currency: string;
  priceMode: WatchSpec['priceMode'];
  maxPrice: number | null;
  /** Отсортированы по цене; не больше NOTIFY.SHOW_ALL_N. */
  offers: AlertOffer[];
  /** Всего подходящих (для «ещё N»). */
  total: number;
  /** Для initial/manual: что знает авто-режим. */
  baseline?: number | null;
  confidence?: PriceStats['confidence'];
  autoTarget?: number | null;
  /** Время проверки, ISO. */
  checkedAt: string;
}

export interface RenderContext {
  names: NameBook;
  now: Date;
  marker: string | null;
  outboxId: number;
}

export interface Rendered {
  text: string;
  keyboard: Keyboard;
}

function buyButtonText(i: number, price: number, currency: string, total: number): string {
  return total === 1 ? 'Купить на Aviasales' : `🛒 ${i + 1} · ${fmtPrice(price, currency)}`;
}

function offerBlock(a: AlertOffer, p: AlertPayload, names: NameBook, index: number | null): string[] {
  const o = a.offer;
  const lines: string[] = [];
  const priceText = `<b>${fmtPrice(o.price, p.currency)}</b>`;
  const reasons = a.reasons.length ? ` — ${reasonsText(a.reasons, p.currency)}` : '';
  if (index === null) {
    lines.push(`💰 ${priceText}${reasons}`);
    lines.push(`📅 ${datesLine(o)}`);
    lines.push(`🔁 ${transfersLine(o, names)}`);
    const d = durationLine(o);
    if (d) lines.push(`⏱ ${d}`);
    const ad = adultsLine(o.price, p.adults, p.currency);
    if (ad) lines.push(ad);
  } else {
    lines.push(`${NUM_EMOJI[index] ?? `${index + 1}.`} ${priceText} · ${datesLine(o)}`);
    lines.push(`      ${o.originAirport}→${o.destAirport} · ${transfersLine(o, names)}`);
    if (a.reasons.length) lines.push(`      ${reasonsText(a.reasons, p.currency)}`);
  }
  return lines;
}

function header(p: AlertPayload, names: NameBook): string {
  const only = p.offers.length === 1 ? p.offers[0]!.offer : null;
  if (only) {
    return `✈️ <b>${airportLabel(only.originAirport, names)} → ${airportLabel(only.destAirport, names)}</b>`;
  }
  return `✈️ <b>${routeTitle(p.origins, p.destinations, names)}</b>`;
}

function modeLine(p: AlertPayload): string | null {
  const parts: string[] = [];
  if (p.priceMode !== 'auto' && p.maxPrice !== null) parts.push(`порог ${fmtPrice(p.maxPrice, p.currency)}`);
  if (p.priceMode !== 'threshold') {
    if (p.baseline && p.autoTarget) {
      parts.push(
        `авто: ${p.confidence === 'low' ? 'типичная цена ≈' : 'медиана'} ${fmtPrice(p.baseline, p.currency)}, ` +
          `сработаю от ${fmtPrice(p.autoTarget, p.currency)}`,
      );
    } else {
      parts.push('авто: пока копим историю цен');
    }
  }
  return parts.length ? `🎯 ${parts.join(' · ')}` : null;
}

/** Уведомление о дешёвой цене / точка отсчёта / результат ручной проверки. */
export function renderAlert(p: AlertPayload, ctx: RenderContext, showAll = false): Rendered {
  const names = ctx.names;
  const limit = showAll ? p.offers.length : Math.min(p.offers.length, 3);
  const shown = p.offers.slice(0, limit);
  const lines: string[] = [];

  if (p.mode === 'initial') lines.push(`✅ <b>Наблюдение #${p.watchId} создано</b>`);
  if (p.mode === 'manual') lines.push(`🔄 <b>Проверка #${p.watchId}</b>`);

  if (shown.length === 0) {
    lines.push(`✈️ <b>${routeTitle(p.origins, p.destinations, names)}</b>`);
    lines.push(
      'Сейчас в кэше Aviasales нет подходящих билетов на эти даты. Для редких направлений это нормально — ' +
        'буду проверять дальше и напишу, как только появится подходящая цена.',
    );
    const ml = modeLine(p);
    if (ml) lines.push(ml);
    return { text: lines.join('\n'), keyboard: [[{ text: '⏸ Пауза', callback_data: `a:pause:${p.watchId}` }]] };
  }

  lines.push(header(p, names));
  if (p.mode !== 'alert') {
    lines.push(p.mode === 'initial' ? '📍 Точка отсчёта — самое дешёвое сейчас:' : 'Самое дешёвое сейчас:');
  } else if (p.total > 1) {
    lines.push(`Нашёл ${p.total} ${plural(p.total, ['дешёвый вариант', 'дешёвых варианта', 'дешёвых вариантов'])}:`);
  }

  if (shown.length === 1) {
    lines.push(...offerBlock(shown[0]!, p, names, null));
  } else {
    shown.forEach((a, i) => lines.push(...offerBlock(a, p, names, i)));
    const ad = adultsLine(shown[0]!.offer.price, p.adults, p.currency);
    if (ad) lines.push(ad);
  }
  const rest = p.total - shown.length;
  if (rest > 0) lines.push(`…и ещё ${rest} ${plural(rest, ['вариант', 'варианта', 'вариантов'])}`);
  lines.push(cacheLine(shown.map((a) => a.offer), ctx.now));
  if (p.mode !== 'alert') {
    const ml = modeLine(p);
    if (ml) lines.push(ml);
  }
  lines.push(`🔔 Наблюдение #${p.watchId}`);

  const keyboard: Keyboard = [];
  shown.forEach((a, i) => {
    const row: Button[] = [
      {
        text: buyButtonText(i, a.offer.price, p.currency, shown.length),
        url: buildBuyLink(a.offer, { adults: p.adults, marker: ctx.marker }),
      },
    ];
    if (p.mode === 'alert') row.push({ text: shown.length === 1 ? '🔕 Не показывать этот рейс' : `🔕 ${i + 1}`, callback_data: `a:mute:${ctx.outboxId}:${i}` });
    keyboard.push(row);
  });
  const last: Button[] = [];
  if (!showAll && p.offers.length > shown.length) {
    last.push({ text: `📋 Показать все (${p.offers.length})`, callback_data: `a:more:${ctx.outboxId}` });
  }
  last.push({ text: '⏸ Пауза watch', callback_data: `a:pause:${p.watchId}` });
  keyboard.push(last);
  return { text: lines.join('\n'), keyboard };
}

export interface DigestItem {
  outboxId: number;
  createdAt: string;
  payload: AlertPayload;
}

/** Дайджест отложенных уведомлений (тихие часы / дневной лимит). */
export function renderDigest(
  items: DigestItem[],
  ctx: { names: NameBook; now: Date; marker: string | null; tz: string; maxOffers: number },
): Rendered {
  const lines: string[] = [`🌙 <b>Отложенные уведомления (${items.length})</b>`, 'Собрал, пока шли тихие часы или действовал дневной лимит:'];
  const keyboard: Keyboard = [];
  const all: Offer[] = [];
  let n = 0;
  for (const it of items) {
    const p = it.payload;
    lines.push('', `✈️ <b>${routeTitle(p.origins, p.destinations, ctx.names)}</b> · #${p.watchId}`);
    for (const a of p.offers.slice(0, 3)) {
      if (n >= ctx.maxOffers) break;
      const o = a.offer;
      lines.push(`${NUM_EMOJI[n] ?? `${n + 1}.`} <b>${fmtPrice(o.price, p.currency)}</b> · ${datesLine(o)}`);
      lines.push(`      ${o.originAirport}→${o.destAirport} · ${transfersLine(o, ctx.names)}`);
      if (a.reasons.length) lines.push(`      ${reasonsText(a.reasons, p.currency)}`);
      if (keyboard.length < 8) {
        keyboard.push([
          {
            text: `🛒 ${n + 1} · ${fmtPrice(o.price, p.currency)}`,
            url: buildBuyLink(o, { adults: p.adults, marker: ctx.marker }),
          },
        ]);
      }
      all.push(o);
      n++;
    }
    const rest = p.total - Math.min(p.offers.length, 3);
    if (rest > 0) lines.push(`…и ещё ${rest} ${plural(rest, ['вариант', 'варианта', 'вариантов'])}`);
  }
  lines.push('', cacheLine(all, ctx.now));
  return { text: lines.join('\n'), keyboard };
}

// ---------- Описание наблюдения ----------

export function describePrice(
  spec: Pick<WatchSpec, 'priceMode' | 'maxPrice' | 'autoSensitivity'>,
  currency: string,
): string {
  const auto = `авто (−${Math.round(spec.autoSensitivity * 100)}% от медианы)`;
  switch (spec.priceMode) {
    case 'threshold':
      return `до ${fmtPrice(spec.maxPrice ?? 0, currency)}`;
    case 'auto':
      return auto;
    case 'both':
      return `до ${fmtPrice(spec.maxPrice ?? 0, currency)} или ${auto}`;
  }
}

export function describeFilters(spec: WatchSpec): string[] {
  const f: string[] = [];
  if (spec.directOnly) f.push('только прямые');
  else if (spec.maxTransfers !== null) f.push(`пересадок ≤ ${spec.maxTransfers}`);
  if (spec.departWeekdays?.length) f.push(`вылет: ${fmtWeekdays(spec.departWeekdays)}`);
  if (spec.returnWeekdays?.length) f.push(`возврат: ${fmtWeekdays(spec.returnWeekdays)}`);
  if (spec.departTimeFrom || spec.departTimeTo) {
    f.push(`вылет ${spec.departTimeFrom ?? '00:00'}–${spec.departTimeTo ?? '23:59'}`);
  }
  if (spec.maxDurationMin) f.push(`в пути ≤ ${fmtDuration(spec.maxDurationMin)}`);
  if (spec.excludeAirlines?.length) f.push(`без ${spec.excludeAirlines.join(', ')}`);
  if (spec.adults > 1) f.push(`${spec.adults} ${plural(spec.adults, ['взрослый', 'взрослых', 'взрослых'])}`);
  return f;
}

/** Многострочное описание наблюдения (мастер, /list). */
export function describeWatch(spec: WatchSpec, names: NameBook, currency: string): string {
  const lines: string[] = [];
  const type = spec.tripType === 'roundtrip' ? 'туда-обратно' : 'в одну сторону';
  lines.push(`✈️ ${routeTitle(spec.origins, spec.destinations, names)} (${type})`);
  let dates = `📅 вылет ${fmtDateRange(spec.departFrom, spec.departTo)}`;
  if (spec.tripType === 'roundtrip' && spec.nightsMin !== null && spec.nightsMax !== null) {
    dates +=
      spec.nightsMin === spec.nightsMax
        ? ` · ${fmtNights(spec.nightsMin)}`
        : ` · ${spec.nightsMin}–${spec.nightsMax} ${plural(spec.nightsMax, ['ночь', 'ночи', 'ночей'])}`;
    if (spec.returnTo) dates += ` · вернуться до ${fmtDate(spec.returnTo, false)}`;
  }
  lines.push(dates);
  const filters = describeFilters(spec);
  if (filters.length) lines.push(`🔎 ${filters.join(' · ')}`);
  lines.push(`💰 ${describePrice(spec, currency)}`);
  return lines.join('\n');
}

export const DETECTOR_HELP =
  `Авто-режим считает медиану минимальных цен за последние ${DETECTOR.BASELINE_WINDOW_DAYS} дней ` +
  `(нужно ≥ ${DETECTOR.BASELINE_MIN_DAYS} дней истории) и сообщает, когда цена ниже неё на заданный процент, ` +
  `или когда цена — новый рекорд за ≥ ${DETECTOR.RECORD_MIN_DAYS} дней наблюдений. ` +
  'Пока истории мало, опирается на календарь цен Aviasales и требует скидку в 1,5 раза больше.';
