import * as z from 'zod/mini';
import { PROVIDER } from '../config.ts';
import type { CalendarQuery } from '../core/queryPlanner.ts';
import type { FareQuery, Offer } from '../core/types.ts';
import { ProviderError, type CalendarPoint, type FareProvider, type SearchPage } from './FareProvider.ts';

/**
 * Travelpayouts / Aviasales Data API.
 * Документация: https://support.travelpayouts.com/hc/en-us/articles/203956163 (сверено 2026-09-28).
 * Лимиты: prices_for_dates и grouped_prices — 600 запросов/мин (статья «API rate limits»).
 */
export const TP_BASE_URL = 'https://api.travelpayouts.com';

// ---------- Схемы ответа (zod/mini — в ~25 раз меньше полного zod в бандле Worker) ----------

const toNumOrNull = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const optNum = z.pipe(z.optional(z.union([z.number(), z.string(), z.null()])), z.transform(toNumOrNull));
const optStr = z.pipe(
  z.optional(z.union([z.string(), z.null()])),
  z.transform((v: string | null | undefined): string | null => (v ? v : null)),
);

/** Запись prices_for_dates (и значение grouped_prices). Незнакомые поля игнорируются. */
export const PriceItemSchema = z.object({
  origin: optStr,
  destination: optStr,
  origin_airport: z.string().check(z.minLength(2)),
  destination_airport: z.string().check(z.minLength(2)),
  price: z.coerce.number().check(z.positive()),
  airline: z._default(z.string(), ''),
  flight_number: z.pipe(
    z.optional(z.union([z.string(), z.number()])),
    z.transform((v: string | number | undefined): string => (v === undefined ? '' : String(v))),
  ),
  departure_at: z.string().check(z.minLength(10)),
  return_at: optStr,
  transfers: optNum,
  return_transfers: optNum,
  duration: optNum,
  duration_to: optNum,
  duration_back: optNum,
  link: z._default(z.string(), ''),
  found_at: optStr,
  expires_at: optStr,
});
export type PriceItem = z.infer<typeof PriceItemSchema>;

export const PricesForDatesSchema = z.object({
  success: z.boolean(),
  // при ошибке документация обещает "data": {}
  data: z.optional(z.nullable(z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]))),
  currency: z.optional(z.string()),
  error: z.optional(z.nullable(z.string())),
});

export const GroupedPricesSchema = z.object({
  success: z.boolean(),
  data: z.optional(z.nullable(z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]))),
  currency: z.optional(z.string()),
  error: z.optional(z.nullable(z.string())),
});

// ---------- Нормализация ----------

export function normalizeItem(item: PriceItem, currency: string): Offer {
  const transfersOut = item.transfers ?? 0;
  return {
    originAirport: item.origin_airport.toUpperCase(),
    destAirport: item.destination_airport.toUpperCase(),
    departAt: item.departure_at,
    returnAt: item.return_at,
    price: Math.round(item.price),
    currency: currency.toLowerCase(),
    airline: item.airline.toUpperCase(),
    flightNumber: item.flight_number,
    transfersOut,
    transfersBack: item.return_at ? (item.return_transfers ?? null) : null,
    durationMin: item.duration,
    durationOutMin: item.duration_to ?? (item.return_at ? null : item.duration),
    durationBackMin: item.return_at ? item.duration_back : null,
    link: item.link,
    foundAt: item.found_at,
    expiresAt: item.expires_at,
  };
}

/** Разбор массива записей: невалидные пропускаются; если невалидно всё — это смена схемы API. */
export function parseItems(items: unknown[], currency: string): { offers: Offer[]; invalid: number } {
  const offers: Offer[] = [];
  let invalid = 0;
  for (const raw of items) {
    const r = PriceItemSchema.safeParse(raw);
    if (r.success) offers.push(normalizeItem(r.data, currency));
    else invalid++;
  }
  if (items.length > 0 && offers.length === 0) {
    throw new ProviderError('bad_response', `All ${items.length} items failed schema validation`);
  }
  return { offers, invalid };
}

// ---------- HTTP-клиент ----------

export interface TravelpayoutsOptions {
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export class TravelpayoutsProvider implements FareProvider {
  readonly id = 'travelpayouts';
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(opts: TravelpayoutsOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? PROVIDER.TIMEOUT_MS;
    this.baseUrl = opts.baseUrl ?? TP_BASE_URL;
  }

  async search(q: FareQuery, page: number, limit: number): Promise<SearchPage> {
    const params = new URLSearchParams({
      origin: q.origin,
      destination: q.destination,
      departure_at: q.departureAt,
      one_way: String(q.oneWay),
      direct: String(q.direct),
      sorting: 'price',
      unique: 'false',
      limit: String(limit),
      page: String(page),
      currency: q.currency,
      market: q.market,
    });
    if (q.returnAt && !q.oneWay) params.set('return_at', q.returnAt);
    const { json, bytes } = await this.get('/aviasales/v3/prices_for_dates', params);
    const body = PricesForDatesSchema.safeParse(json);
    if (!body.success) throw new ProviderError('bad_response', 'prices_for_dates: unexpected envelope');
    if (!body.data.success) {
      throw new ProviderError('client', `prices_for_dates: ${body.data.error ?? 'success=false'}`);
    }
    const items = body.data.data ?? [];
    if (!Array.isArray(items)) throw new ProviderError('bad_response', 'prices_for_dates: data is not an array');
    const { offers } = parseItems(items, body.data.currency ?? q.currency);
    return { offers, rawCount: items.length, bytes };
  }

  async calendar(q: CalendarQuery): Promise<CalendarPoint[]> {
    const params = new URLSearchParams({
      origin: q.origin,
      destination: q.destination,
      departure_at: q.month,
      group_by: 'departure_at',
      direct: String(q.direct),
      currency: q.currency,
      market: q.market,
    });
    if (!q.oneWay) {
      // для туда-обратно grouped_prices учитывает длительность поездки; месяц возврата не фиксируем
      if (q.minTripDuration !== null) params.set('min_trip_duration', String(q.minTripDuration));
      if (q.maxTripDuration !== null) params.set('max_trip_duration', String(q.maxTripDuration));
    }
    const { json } = await this.get('/aviasales/v3/grouped_prices', params);
    const body = GroupedPricesSchema.safeParse(json);
    if (!body.success) throw new ProviderError('bad_response', 'grouped_prices: unexpected envelope');
    if (!body.data.success) throw new ProviderError('client', `grouped_prices: ${body.data.error ?? 'success=false'}`);
    const data = body.data.data ?? {};
    const values = Array.isArray(data) ? data : Object.values(data);
    const points: CalendarPoint[] = [];
    for (const raw of values) {
      const r = PriceItemSchema.safeParse(raw);
      if (!r.success) continue;
      // для туда-обратно нужны только варианты с возвратом, для «в одну сторону» — без
      if (q.oneWay !== !r.data.return_at) continue;
      points.push({ departDate: r.data.departure_at.slice(0, 10), price: Math.round(r.data.price) });
    }
    return points;
  }

  private async get(path: string, params: URLSearchParams): Promise<{ json: unknown; bytes: number }> {
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        // токен — только в заголовке, чтобы не светить его в логах URL
        headers: { 'X-Access-Token': this.token, 'Accept-Encoding': 'gzip, deflate', Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError('timeout', `${path}: timeout after ${this.timeoutMs} ms`);
      }
      throw new ProviderError('network', `${path}: ${(e as Error)?.message ?? 'network error'}`);
    }

    if (res.status === 401 || res.status === 403) {
      void res.body?.cancel().catch(() => undefined);
      throw new ProviderError('auth', `${path}: HTTP ${res.status} (invalid token?)`, res.status);
    }
    if (res.status === 429) {
      const reset = Number(res.headers.get('X-Rate-Limit-Reset') ?? res.headers.get('Retry-After'));
      void res.body?.cancel().catch(() => undefined);
      throw new ProviderError('rate_limit', `${path}: HTTP 429`, 429, Number.isFinite(reset) && reset > 0 ? reset : null);
    }
    if (res.status >= 500) {
      void res.body?.cancel().catch(() => undefined);
      throw new ProviderError('server', `${path}: HTTP ${res.status}`, res.status);
    }
    const text = await res.text().catch(() => {
      throw new ProviderError('network', `${path}: failed to read body`);
    });
    if (res.status >= 400) {
      throw new ProviderError('client', `${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    }
    try {
      return { json: JSON.parse(text), bytes: text.length };
    } catch {
      throw new ProviderError('bad_response', `${path}: invalid JSON`);
    }
  }
}
