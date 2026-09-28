/**
 * Smoke-тест реального API (SPEC §12): запрос к prices_for_dates / grouped_prices / places2
 * с токеном из .dev.vars и проверка схемы ответа через zod. Нужен, чтобы заметить изменения API.
 *
 *   npm run smoke
 *   npm run smoke -- MOW AYT        # другой маршрут
 */
import { addMonths } from '../src/core/dates.ts';
import { searchPlaces } from '../src/providers/autocomplete.ts';
import { PriceItemSchema, PricesForDatesSchema, TP_BASE_URL, TravelpayoutsProvider } from '../src/providers/travelpayouts.ts';
import { readDevVars, requireVars } from './lib/devvars.ts';

const vars = readDevVars();
requireVars(vars, ['TRAVELPAYOUTS_TOKEN']);
const [origin = 'MOW', destination = 'IST'] = process.argv.slice(2);
const month = addMonths(new Date().toISOString().slice(0, 7), 1);
let failed = false;
const fail = (msg: string) => {
  failed = true;
  console.error(`✗ ${msg}`);
};

// 1. prices_for_dates — «сырой» ответ, чтобы увидеть и незнакомые поля
const params = new URLSearchParams({ origin, destination, departure_at: month, return_at: month, one_way: 'false', direct: 'false', sorting: 'price', unique: 'false', limit: '30', page: '1', currency: 'rub', market: 'ru' });
const res = await fetch(`${TP_BASE_URL}/aviasales/v3/prices_for_dates?${params}`, { headers: { 'X-Access-Token': vars.TRAVELPAYOUTS_TOKEN!, 'Accept-Encoding': 'gzip, deflate' } });
console.log(`prices_for_dates ${origin}→${destination} ${month}: HTTP ${res.status}, rate limit ${res.headers.get('X-Rate-Limit-Remaining')}/${res.headers.get('X-Rate-Limit')}`);
const body = (await res.json()) as unknown;
const env = PricesForDatesSchema.safeParse(body);
if (!res.ok || !env.success || !env.data.success) {
  fail(`неожиданный ответ: ${JSON.stringify(body).slice(0, 300)}`);
} else {
  const items = Array.isArray(env.data.data) ? env.data.data : [];
  const known = new Set(Object.keys(PriceItemSchema.shape));
  const unknownFields = new Set<string>();
  let invalid = 0;
  for (const it of items) {
    if (!PriceItemSchema.safeParse(it).success) invalid++;
    for (const k of Object.keys(it as object)) if (!known.has(k)) unknownFields.add(k);
  }
  console.log(`  записей: ${items.length}, невалидных: ${invalid}${unknownFields.size ? `, новые поля: ${[...unknownFields].join(', ')}` : ''}`);
  if (items.length && invalid === items.length) fail('ни одна запись не прошла схему — API изменился?');
  if (items[0]) console.log('  пример:', JSON.stringify(items[0]).slice(0, 400));
  if (!items.length) console.warn('  (пусто — для этого маршрута/месяца в кэше нет цен; попробуй другой: npm run smoke -- MOW AYT)');
}

// 2. тот же путь через провайдер + grouped_prices
const provider = new TravelpayoutsProvider({ token: vars.TRAVELPAYOUTS_TOKEN! });
try {
  const cal = await provider.calendar({ origin, destination, month, oneWay: false, direct: false, minTripDuration: 5, maxTripDuration: 10, currency: 'rub', market: 'ru' });
  console.log(`grouped_prices: дней с ценой ${cal.length}${cal[0] ? `, например ${cal[0].departDate} — ${cal[0].price} ₽` : ''}`);
} catch (e) {
  fail(`grouped_prices: ${(e as Error).message}`);
}

// 3. автодополнение
try {
  const places = await searchPlaces('Москва');
  console.log(`places2 «Москва»: ${places.map((p) => p.code).join(', ')}`);
  if (!places.some((p) => p.code === 'MOW')) fail('places2 не вернул MOW');
} catch (e) {
  fail(`places2: ${(e as Error).message}`);
}

console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE OK');
process.exit(failed ? 1 : 0);
