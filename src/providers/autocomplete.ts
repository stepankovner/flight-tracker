import * as z from 'zod/mini';
import { PROVIDER } from '../config.ts';
import { ProviderError } from './FareProvider.ts';

/**
 * Автодополнение городов/аэропортов Travelpayouts (без токена).
 * GET https://autocomplete.travelpayouts.com/places2?term=...&locale=ru&types[]=city&types[]=airport
 */
export const AUTOCOMPLETE_URL = 'https://autocomplete.travelpayouts.com/places2';

const optStr = z.optional(z.nullable(z.string()));
const PlaceSchema = z.object({
  type: z.string(),
  code: z.string().check(z.regex(/^[A-Z0-9]{3}$/)),
  name: optStr,
  city_code: optStr,
  city_name: optStr,
  country_name: optStr,
  weight: z.optional(z.nullable(z.number())),
});

export interface Place {
  kind: 'city' | 'airport';
  code: string;
  name: string;
  cityCode: string | null;
  cityName: string | null;
  countryName: string | null;
  weight: number;
}

export function parsePlaces(json: unknown): Place[] {
  if (!Array.isArray(json)) throw new ProviderError('bad_response', 'places2: expected array');
  const out: Place[] = [];
  for (const raw of json) {
    const r = PlaceSchema.safeParse(raw);
    if (!r.success) continue;
    const p = r.data;
    if (p.type !== 'city' && p.type !== 'airport') continue;
    out.push({
      kind: p.type,
      code: p.code,
      name: p.name ?? p.code,
      cityCode: p.type === 'city' ? p.code : (p.city_code ?? null),
      cityName: p.type === 'city' ? (p.name ?? null) : (p.city_name ?? null),
      countryName: p.country_name ?? null,
      weight: p.weight ?? 0,
    });
  }
  return out;
}

export async function searchPlaces(
  term: string,
  opts: { fetch?: typeof fetch; locale?: string; timeoutMs?: number } = {},
): Promise<Place[]> {
  const params = new URLSearchParams({ term, locale: opts.locale ?? 'ru' });
  params.append('types[]', 'city');
  params.append('types[]', 'airport');
  const f = opts.fetch ?? ((...a) => fetch(...a));
  let res: Response;
  try {
    res = await f(`${AUTOCOMPLETE_URL}?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROVIDER.TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new ProviderError(name === 'TimeoutError' ? 'timeout' : 'network', `places2: ${(e as Error)?.message}`);
  }
  if (res.status === 429) throw new ProviderError('rate_limit', 'places2: HTTP 429', 429);
  if (res.status >= 500) throw new ProviderError('server', `places2: HTTP ${res.status}`, res.status);
  if (!res.ok) throw new ProviderError('client', `places2: HTTP ${res.status}`, res.status);
  return parsePlaces(await res.json());
}

export type PlaceChoice = { kind: 'resolved'; place: Place } | { kind: 'ambiguous'; options: Place[] } | { kind: 'none' };

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[-\s]+/g, ' ').trim();

/**
 * Выбор места по результатам автодополнения.
 * Однозначно, если: точное совпадение IATA-кода; единственный кандидат; или первый кандидат «весит»
 * в 10+ раз больше следующего конкурента (аэропорты того же города конкурентами не считаются).
 */
export function choosePlace(term: string, places: Place[], maxOptions: number): PlaceChoice {
  if (places.length === 0) return { kind: 'none' };
  const t = term.trim();
  if (/^[A-Za-z]{3}$/.test(t)) {
    const code = t.toUpperCase();
    const exact = places.find((p) => p.code === code && p.kind === 'city') ?? places.find((p) => p.code === code);
    if (exact) return { kind: 'resolved', place: exact };
  }
  const top = places[0]!;
  const competitors = places.slice(1).filter((p) => !(p.kind === 'airport' && p.cityCode === top.cityCode));
  if (competitors.length === 0) return { kind: 'resolved', place: top };
  const next = competitors[0]!;
  const nt = norm(t);
  const exactName = norm(top.name) === nt || (top.cityName !== null && norm(top.cityName) === nt);
  const nextExact = norm(next.name) === nt;
  if (top.weight >= next.weight * 10 && (exactName || !nextExact)) return { kind: 'resolved', place: top };
  if (exactName && !nextExact && top.weight >= next.weight * 3) return { kind: 'resolved', place: top };
  // варианты: сначала города, потом аэропорты; без дублей кодов
  const seen = new Set<string>();
  const options = places.filter((p) => (seen.has(p.code) ? false : (seen.add(p.code), true))).slice(0, maxOptions);
  return { kind: 'ambiguous', options };
}

export function placeLabel(p: Place): string {
  const where = p.kind === 'airport' ? `${p.name}, ${p.cityName ?? ''}`.replace(/, $/, '') : p.name;
  return `${where} (${p.code})${p.countryName ? `, ${p.countryName}` : ''}`;
}

/** Справочник авиакомпаний: https://api.travelpayouts.com/data/ru/airlines.json */
export const AIRLINES_URL = 'https://api.travelpayouts.com/data/ru/airlines.json';

const AirlineSchema = z.object({
  code: optStr,
  name: optStr,
  name_translations: z.optional(z.nullable(z.record(z.string(), z.string()))),
});

export async function fetchAirlines(opts: { fetch?: typeof fetch } = {}): Promise<Array<{ code: string; name: string }>> {
  const f = opts.fetch ?? ((...a) => fetch(...a));
  const res = await f(AIRLINES_URL, { signal: AbortSignal.timeout(PROVIDER.TIMEOUT_MS) });
  if (!res.ok) throw new ProviderError(res.status >= 500 ? 'server' : 'client', `airlines.json: HTTP ${res.status}`, res.status);
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) throw new ProviderError('bad_response', 'airlines.json: expected array');
  const out: Array<{ code: string; name: string }> = [];
  for (const raw of json) {
    const r = AirlineSchema.safeParse(raw);
    if (!r.success || !r.data.code || !/^[A-Z0-9]{2}$/.test(r.data.code)) continue;
    const name = r.data.name || r.data.name_translations?.en;
    if (name) out.push({ code: r.data.code, name });
  }
  return out;
}
