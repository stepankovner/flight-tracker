import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { choosePlace, fetchAirlines, parsePlaces, placeLabel, searchPlaces, type Place } from '../src/providers/autocomplete.ts';
import { ProviderError } from '../src/providers/FareProvider.ts';
import { fastParseItem, parseItems, PriceItemSchema, TravelpayoutsProvider } from '../src/providers/travelpayouts.ts';
import { rawItem } from './helpers.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(responses: Array<Response | Error | (() => Response)>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r.clone();
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const query = {
  origin: 'MOW',
  destination: 'IST',
  departureAt: '2026-11',
  returnAt: '2026-11',
  oneWay: false,
  direct: false,
  currency: 'rub',
  market: 'ru',
};

describe('TravelpayoutsProvider.search', () => {
  it('разбирает ответ по документированной схеме и нормализует офферы', async () => {
    const { fetch, calls } = fakeFetch([json(fixture('prices_for_dates.json'))]);
    const p = new TravelpayoutsProvider({ token: 'secret-token-1234567890', fetch });
    const page = await p.search(query, 1, 200);

    expect(page.rawCount).toBe(3);
    expect(page.offers).toHaveLength(2); // третья запись битая — пропущена
    expect(page.bytes).toBeGreaterThan(100);
    expect(page.offers[0]).toEqual({
      originAirport: 'SVO',
      destAirport: 'SAW',
      departAt: '2026-11-18T06:40:00+03:00',
      returnAt: '2026-11-25T18:20:00+03:00',
      price: 8450,
      currency: 'rub',
      airline: 'PC',
      flightNumber: '395',
      transfersOut: 1,
      transfersBack: 0,
      durationMin: 600,
      durationOutMin: 360,
      durationBackMin: 240,
      link: expect.stringContaining('/search/MOW1811IST25111'),
      foundAt: null,
      expiresAt: null,
    });
    expect(page.offers[1]!.flightNumber).toBe('418'); // число → строка

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.travelpayouts.com/aviasales/v3/prices_for_dates');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      origin: 'MOW',
      destination: 'IST',
      departure_at: '2026-11',
      return_at: '2026-11',
      one_way: 'false',
      direct: 'false',
      sorting: 'price',
      unique: 'false',
      limit: '200',
      page: '1',
      currency: 'rub',
      market: 'ru',
    });
    // токен — только в заголовке
    expect(calls[0]!.url).not.toContain('secret-token');
    expect(calls[0]!.headers['x-access-token']).toBe('secret-token-1234567890');
  });

  it('oneway: без return_at, one_way=true', async () => {
    const { fetch, calls } = fakeFetch([json({ success: true, data: [], currency: 'rub' })]);
    const p = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch });
    const page = await p.search({ ...query, oneWay: true, returnAt: null }, 2, 50);
    expect(page.offers).toEqual([]);
    const params = new URL(calls[0]!.url).searchParams;
    expect(params.get('one_way')).toBe('true');
    expect(params.has('return_at')).toBe(false);
    expect(params.get('page')).toBe('2');
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [500, 'server'],
    [502, 'server'],
    [400, 'client'],
  ])('HTTP %i → %s', async (status, kind) => {
    const { fetch } = fakeFetch([json({ error: 'x' }, status, status === 429 ? { 'X-Rate-Limit-Reset': '42' } : {})]);
    const p = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch });
    const e = await p.search(query, 1, 10).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe(kind);
    if (status === 429) expect(e.retryAfterSec).toBe(42);
    expect(e.retryable).toBe(kind === 'server');
  });

  it('таймаут и сетевые ошибки', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const p1 = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch: fakeFetch([timeout]).fetch });
    expect((await p1.search(query, 1, 10).catch((x) => x)).kind).toBe('timeout');
    const p2 = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch: fakeFetch([new TypeError('fetch failed')]).fetch });
    expect((await p2.search(query, 1, 10).catch((x) => x)).kind).toBe('network');
  });

  it('реальный таймаут через AbortSignal', async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const p = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch: hanging, timeoutMs: 20 });
    expect((await p.search(query, 1, 10).catch((x) => x)).kind).toBe('timeout');
  });

  it('неожиданный формат → bad_response; success=false → client', async () => {
    const p1 = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch: fakeFetch([new Response('<html>')]).fetch });
    expect((await p1.search(query, 1, 10).catch((x) => x)).kind).toBe('bad_response');
    const p2 = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch: fakeFetch([json({ data: 5 })]).fetch });
    expect((await p2.search(query, 1, 10).catch((x) => x)).kind).toBe('bad_response');
    const p3 = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch: fakeFetch([json({ success: false, data: {}, error: 'bad dates' })]).fetch });
    const e3 = await p3.search(query, 1, 10).catch((x) => x);
    expect(e3.kind).toBe('client');
    expect(e3.message).toContain('bad dates');
  });

  it('если невалидны все записи — считаем, что схема API изменилась', () => {
    expect(() => parseItems([{ foo: 1 }, { bar: 2 }], 'rub')).toThrow(ProviderError);
    expect(parseItems([], 'rub')).toEqual({ offers: [], invalid: 0 });
  });

  it('быстрый разбор совпадает со схемой zod на граничных случаях', () => {
    const cases: unknown[] = [
      rawItem(),
      rawItem({ price: '9000' }),
      rawItem({ price: -5 }),
      rawItem({ price: 0 }),
      rawItem({ price: 'abc' }),
      rawItem({ price: null }),
      rawItem({ price: true }),
      rawItem({ flight_number: 418 }),
      rawItem({ flight_number: undefined }),
      rawItem({ flight_number: null }),
      rawItem({ airline: undefined, link: undefined }),
      rawItem({ airline: null }),
      rawItem({ link: 5 }),
      rawItem({ return_at: null, return_transfers: null }),
      rawItem({ return_at: '' }),
      rawItem({ return_at: 7 }),
      rawItem({ transfers: '1' }),
      rawItem({ transfers: 'x' }),
      rawItem({ transfers: '' }),
      rawItem({ transfers: true }),
      rawItem({ duration: undefined, duration_to: null }),
      rawItem({ origin_airport: 'S' }),
      rawItem({ destination_airport: undefined }),
      rawItem({ departure_at: '2026-11' }),
      rawItem({ found_at: '2026-09-28T10:00:00Z', expires_at: '2026-09-29T10:00:00Z', gate: 'Kiwi' }),
      null,
      'string',
      [1, 2],
      {},
    ];
    for (const c of cases) {
      const z = PriceItemSchema.safeParse(c);
      const f = fastParseItem(c);
      expect(f !== null, JSON.stringify(c)).toBe(z.success);
      if (z.success) expect(f).toEqual(z.data);
    }
  });

  it('схема терпима к null и отсутствующим полям', () => {
    const r = PriceItemSchema.safeParse(rawItem({ return_at: null, return_transfers: null, duration_to: undefined, link: undefined, airline: undefined }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.return_at).toBeNull();
      expect(r.data.link).toBe('');
      expect(r.data.airline).toBe('');
    }
    expect(PriceItemSchema.safeParse(rawItem({ price: -5 })).success).toBe(false);
    expect(PriceItemSchema.safeParse(rawItem({ price: '9000' })).success).toBe(true);
  });
});

describe('TravelpayoutsProvider.calendar (grouped_prices)', () => {
  it('минимальные цены по датам вылета, только туда-обратно', async () => {
    const { fetch, calls } = fakeFetch([json(fixture('grouped_prices.json'))]);
    const p = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch });
    const points = await p.calendar({ origin: 'MOW', destination: 'IST', month: '2026-11', oneWay: false, direct: false, minTripDuration: 6, maxTripDuration: 9, currency: 'rub', market: 'ru' });
    expect(points).toEqual([
      { departDate: '2026-11-15', price: 11000 },
      { departDate: '2026-11-16', price: 12500 },
      { departDate: '2026-11-17', price: 9800 },
    ]);
    const params = new URL(calls[0]!.url).searchParams;
    expect(params.get('group_by')).toBe('departure_at');
    expect(params.get('min_trip_duration')).toBe('6');
    expect(params.get('max_trip_duration')).toBe('9');
    // oneway-запрос отбрасывает записи с возвратом
    const p2 = new TravelpayoutsProvider({ token: 't'.repeat(32), fetch: fakeFetch([json(fixture('grouped_prices.json'))]).fetch });
    expect(await p2.calendar({ origin: 'MOW', destination: 'IST', month: '2026-11', oneWay: true, direct: false, minTripDuration: null, maxTripDuration: null, currency: 'rub', market: 'ru' })).toEqual([]);
  });
});

describe('autocomplete', () => {
  const moscow = parsePlaces(fixture('places2_moscow.json'));

  it('разбор ответа places2', () => {
    expect(moscow[0]).toMatchObject({ kind: 'city', code: 'MOW', name: 'Москва', cityCode: 'MOW', countryName: 'Россия' });
    expect(moscow.find((p) => p.code === 'SVO')).toMatchObject({ kind: 'airport', cityCode: 'MOW', cityName: 'Москва' });
    expect(() => parsePlaces({})).toThrow(ProviderError);
  });

  it('однозначный город: аэропорты того же города не конкуренты', () => {
    const c = choosePlace('Москва', moscow, 6);
    expect(c.kind === 'resolved' && c.place.code).toBe('MOW');
    expect(placeLabel(moscow[0]!)).toBe('Москва (MOW), Россия');
  });

  it('точный IATA-код', () => {
    const c = choosePlace('svo', moscow, 6);
    expect(c.kind === 'resolved' && c.place.code).toBe('SVO');
  });

  it('город с явным лидером по весу', () => {
    const c = choosePlace('Александрия', parsePlaces(fixture('places2_alexandria.json')), 6);
    expect(c.kind === 'resolved' && c.place.code).toBe('ALY');
  });

  it('неоднозначность → варианты', () => {
    const places: Place[] = [
      { kind: 'city', code: 'AAA', name: 'Сан-Хосе', cityCode: 'AAA', cityName: 'Сан-Хосе', countryName: 'Коста-Рика', weight: 1000 },
      { kind: 'city', code: 'SJC', name: 'Сан-Хосе', cityCode: 'SJC', cityName: 'Сан-Хосе', countryName: 'США', weight: 800 },
      { kind: 'airport', code: 'SJO', name: 'Хуан Сантамария', cityCode: 'AAA', cityName: 'Сан-Хосе', countryName: 'Коста-Рика', weight: 700 },
    ];
    const c = choosePlace('Сан-Хосе', places, 6);
    expect(c.kind).toBe('ambiguous');
    if (c.kind === 'ambiguous') expect(c.options.map((o) => o.code)).toEqual(['AAA', 'SJC', 'SJO']);
    expect(choosePlace('xyz', [], 6)).toEqual({ kind: 'none' });
  });

  it('searchPlaces: параметры и ошибки', async () => {
    const { fetch, calls } = fakeFetch([json(fixture('places2_moscow.json'))]);
    const places = await searchPlaces('Москва', { fetch });
    expect(places.length).toBeGreaterThan(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.getAll('types[]')).toEqual(['city', 'airport']);
    expect(url.searchParams.get('locale')).toBe('ru');
    expect((await searchPlaces('x', { fetch: fakeFetch([json({}, 503)]).fetch }).catch((e) => e)).kind).toBe('server');
    expect((await searchPlaces('x', { fetch: fakeFetch([json({}, 429)]).fetch }).catch((e) => e)).kind).toBe('rate_limit');
  });

  it('справочник авиакомпаний', async () => {
    const { fetch } = fakeFetch([
      json([
        { code: 'SU', name: 'Аэрофлот', name_translations: { en: 'Aeroflot' } },
        { code: 'ME', name: null, name_translations: { en: 'Middle East Airlines' } },
        { code: null, name: 'Broken' },
        { code: 'TOOLONG', name: 'X' },
      ]),
    ]);
    expect(await fetchAirlines({ fetch })).toEqual([
      { code: 'SU', name: 'Аэрофлот' },
      { code: 'ME', name: 'Middle East Airlines' },
    ]);
  });
});
