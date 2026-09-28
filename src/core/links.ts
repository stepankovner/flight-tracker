import { AVIASALES_HOST } from '../config.ts';
import { localDateOf } from './filters.ts';
import type { Offer } from './types.ts';

/** '2026-11-12' → '1211' (DDMM, формат поисковых ссылок Aviasales). */
function ddmm(isoDate: string): string {
  return `${isoDate.slice(8, 10)}${isoDate.slice(5, 7)}`;
}

/**
 * Поисковый путь Aviasales: /search/{ORIG}{DDMM}{DEST}{DDMM возврата}{взрослых}.
 * Формат сверен с примерами `link` в документации Data API (например, /search/MAD2807BCN26081).
 */
export function buildSearchPath(p: {
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string | null;
  adults: number;
}): string {
  const adults = Math.min(Math.max(1, Math.trunc(p.adults)), 9);
  return `/search/${p.origin}${ddmm(p.departDate)}${p.destination}${p.returnDate ? ddmm(p.returnDate) : ''}${adults}`;
}

const SEARCH_SEGMENT_RE = /^\/search\/([A-Z]{3}\d{4}[A-Z]{3}(?:\d{4})?)(\d)(?=[?/]|$)/;

/**
 * Ссылка «Купить на Aviasales»: host + offer.link (+ marker, + число взрослых).
 * Если link пустой — собираем поисковую ссылку.
 */
export function buildBuyLink(offer: Offer, opts: { adults: number; marker?: string | null; host?: string }): string {
  const host = opts.host ?? AVIASALES_HOST;
  let path = offer.link?.trim() ?? '';
  if (!path.startsWith('/')) {
    path = buildSearchPath({
      origin: offer.originAirport,
      destination: offer.destAirport,
      departDate: localDateOf(offer.departAt),
      returnDate: offer.returnAt ? localDateOf(offer.returnAt) : null,
      adults: opts.adults,
    });
  } else if (opts.adults > 1) {
    // в ссылке из API зашит 1 пассажир — меняем на нужное число
    path = path.replace(SEARCH_SEGMENT_RE, (_m, route: string) => `/search/${route}${Math.min(opts.adults, 9)}`);
  }
  const url = new URL(path, host);
  if (opts.marker) url.searchParams.set('marker', opts.marker);
  return url.toString();
}

/** Дата поиска из ссылки API (`search_date=DDMMYYYY`) → 'YYYY-MM-DD' или null. */
export function searchDateFromLink(link: string): string | null {
  const m = /[?&]search_date=(\d{2})(\d{2})(\d{4})/.exec(link);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}
