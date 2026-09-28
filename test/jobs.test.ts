import { describe, expect, it } from 'vitest';
import { estimateResponseBytes, isLastPage } from '../src/jobs/checker.ts';
import { runDaily } from '../src/jobs/daily.ts';
import { runInitialCheck } from '../src/jobs/manual.ts';
import { backoffMinutes, runTick } from '../src/jobs/tick.ts';
import { ProviderError } from '../src/providers/FareProvider.ts';
import { Harness } from './harness.ts';
import { offer, spec } from './helpers.ts';

// 28.09.2026 12:00 по Москве
const DAY = '2026-09-28T09:00:00Z';

async function setup(now = DAY, userOpts: Parameters<Harness['user']>[0] = {}) {
  const h = new Harness(now);
  const user = await h.user(userOpts);
  return { h, user };
}

describe('tick: threshold + дедуп (SPEC §14, этап 5)', () => {
  it('два тика подряд с той же ценой → одно уведомление; повтор только при падении ≥5% и ≥300 ₽', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec());
    h.provider.offers = [offer({ price: 8450 }), offer({ price: 12000, flightNumber: '999' })];

    const r1 = await runTick(h.svc());
    expect(r1.checks?.checked).toEqual([id]);
    expect(h.provider.calls.map((c) => c.key)).toEqual(['pfd|MOW|IST|2026-11|2026-11|rt|a|rub|ru', 'pfd|MOW|IST|2026-11|2026-12|rt|a|rub|ru']);
    expect(h.messenger.sent).toHaveLength(1);
    const msg = h.messenger.sent[0]!;
    expect(msg.chatId).toBe(user.chatId);
    expect(msg.text).toContain('8 450 ₽');
    expect(msg.text).toContain('ниже твоего порога');
    expect(msg.opts.silent).toBe(false);
    expect(JSON.stringify(msg.opts.keyboard)).toContain('https://www.aviasales.ru/search/SVO1811IST25111');

    const w = (await h.repo.getWatch(id))!;
    expect(w.lastMinPrice).toBe(8450);
    expect(h.rows('SELECT day, min_price FROM daily_min')).toEqual([{ day: '2026-09-28', min_price: 8450 }]);
    expect(h.rows('SELECT COUNT(*) AS n FROM observations')[0]).toEqual({ n: 2 });

    // тот же тик ещё раз (повтор cron) — watch не «созрел», ничего не происходит
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(1);

    // через час та же цена — без повторного уведомления
    h.advance(61);
    await runTick(h.svc());
    expect(h.provider.calls).toHaveLength(4);
    expect(h.messenger.sent).toHaveLength(1);

    // падение на 5.3% и 450 ₽ → новое уведомление
    h.advance(61);
    h.provider.offers = [offer({ price: 8000 })];
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(2);

    // ещё −1% → молчим
    h.advance(61);
    h.provider.offers = [offer({ price: 7900 })];
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(2);
    expect(h.rows('SELECT times_sent, last_price FROM notified')).toEqual([{ times_sent: 2, last_price: 8000 }]);
  });

  it('несколько подходящих вариантов → одно сообщение с топ-3', async () => {
    const { h, user } = await setup();
    await h.watch(user.id, spec());
    h.provider.offers = [8000, 8100, 8200, 8300, 8400].map((price, i) => offer({ price, flightNumber: String(i) }));
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(1);
    expect(h.messenger.sent[0]!.text).toContain('Нашёл 5 дешёвых вариантов');
    expect(h.messenger.sent[0]!.text).toContain('…и ещё 2 варианта');
    expect(h.rows('SELECT COUNT(*) AS n FROM notified')[0]).toEqual({ n: 5 });
  });

  it('одинаковые запросы разных watch выполняются один раз, кэш работает между тиками', async () => {
    const { h, user } = await setup();
    await h.watch(user.id, spec({ maxPrice: 9000 }));
    await h.watch(user.id, spec({ maxPrice: 5000, departWeekdays: [3] }));
    h.provider.offers = [offer({ price: 8450 })];
    await runTick(h.svc());
    expect(h.provider.calls).toHaveLength(2);
    expect(h.messenger.sent).toHaveLength(1); // второй watch: порог 5000

    // новый watch с тем же маршрутом через 10 минут — ответы берутся из кэша (TTL 30 мин)
    h.advance(10);
    await h.watch(user.id, spec({ maxPrice: 9500 }));
    await runTick(h.svc());
    expect(h.provider.calls).toHaveLength(2);
    expect(h.messenger.sent).toHaveLength(2);
  });

  it('фильтры применяются локально', async () => {
    const { h, user } = await setup();
    await h.watch(user.id, spec({ directOnly: true }));
    h.provider.offers = [offer({ price: 8000, transfersOut: 1 }), offer({ price: 9000, transfersOut: 0, transfersBack: 0, flightNumber: '7' })];
    await runTick(h.svc());
    expect(h.messenger.sent[0]!.text).toContain('9 000');
    expect(h.messenger.sent[0]!.text).not.toContain('8 000');
  });

  it('пагинация: следующая страница, пока последняя цена ≤ порога', async () => {
    const { h, user } = await setup();
    await h.watch(user.id, spec({ tripType: 'oneway', nightsMin: null, nightsMax: null, maxPrice: 50000 }));
    h.provider.offers = Array.from({ length: 450 }, (_, i) =>
      offer({ price: 1000 + i * 100, flightNumber: String(i), returnAt: null, transfersBack: null, departAt: `2026-11-${String(15 + (i % 15)).padStart(2, '0')}T10:00:00+03:00` }),
    );
    await runTick(h.svc());
    expect(h.provider.calls.map((c) => c.page)).toEqual([1, 2, 3]); // MAX_PAGES = 3
    h.provider.calls = [];
    h.advance(61);
    // низкий порог — вторая страница не нужна
    const { h: h2, user: u2 } = await setup();
    await h2.watch(u2.id, spec({ tripType: 'oneway', nightsMin: null, nightsMax: null, maxPrice: 2000 }));
    h2.provider.offers = h.provider.offers;
    await runTick(h2.svc());
    expect(h2.provider.calls.map((c) => c.page)).toEqual([1]);
  });
});

describe('tick: ошибки провайдера (SPEC §5.5)', () => {
  it('429 → пауза с экспоненциальным backoff, watch уходит в следующий тик', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec());
    h.provider.error = new ProviderError('rate_limit', '429', 429, null);
    const r = await runTick(h.svc());
    expect(r.checks?.abort).toBe('rate_limit');
    expect(r.checks?.deferred).toContain(id);
    expect((await h.repo.getWatch(id))!.lastCheckedAt).toBeNull();
    const kv = await h.repo.getKv(['rate_limited_until', 'rate_limit_level']);
    expect(kv.get('rate_limit_level')).toBe('1');
    expect(kv.get('rate_limited_until')).toBe(new Date(h.now.getTime() + 2 * 60_000).toISOString());

    h.advance(1);
    const calls = h.provider.calls.length;
    expect((await runTick(h.svc())).skippedRateLimit).toBe(true);
    expect(h.provider.calls.length).toBe(calls);

    h.advance(2);
    h.provider.error = null;
    h.provider.offers = [offer({ price: 8000 })];
    await runTick(h.svc());
    expect((await h.repo.getWatch(id))!.lastCheckedAt).not.toBeNull();
    expect((await h.repo.getKv(['rate_limit_level'])).get('rate_limit_level')).toBe('0');
    expect(h.messenger.sent).toHaveLength(1);
  });

  it('backoff растёт экспоненциально и уважает retry-after', () => {
    expect([1, 2, 3, 4, 10].map((l) => backoffMinutes(l, null))).toEqual([2, 4, 8, 16, 120]);
    expect(backoffMinutes(1, 600)).toBe(10);
  });

  it('401 → сообщение админу, тик остановлен', async () => {
    const { h, user } = await setup();
    const admin = await h.user({ tgUserId: 9, username: 'admin' });
    const id = await h.watch(user.id, spec());
    h.provider.error = new ProviderError('auth', 'HTTP 401', 401);
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(1);
    expect(h.messenger.sent[0]!.chatId).toBe(admin.chatId);
    expect(h.messenger.sent[0]!.text).toContain('TRAVELPAYOUTS_TOKEN');
    expect((await h.repo.getWatch(id))!.lastCheckedAt).toBeNull();
    // анти-флуд: второе такое же сообщение не шлём
    h.advance(15);
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(1);
  });

  it('5xx: один повтор, затем error_count++; после 10 ошибок подряд — сообщение пользователю', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec({ tripType: 'oneway', nightsMin: null, nightsMax: null }));
    h.provider.error = new ProviderError('server', 'HTTP 502', 502);
    await runTick(h.svc());
    expect(h.provider.calls).toHaveLength(2); // запрос + повтор
    let w = (await h.repo.getWatch(id))!;
    expect(w.errorCount).toBe(1);
    expect(w.lastError).toContain('502');
    for (let i = 0; i < 9; i++) {
      h.advance(61);
      await runTick(h.svc());
    }
    w = (await h.repo.getWatch(id))!;
    expect(w.errorCount).toBe(10);
    expect(h.messenger.texts().filter((t) => t.includes('ошибок источника цен подряд'))).toHaveLength(1);

    // успешная проверка сбрасывает счётчик
    h.advance(61);
    h.provider.error = null;
    await runTick(h.svc());
    expect((await h.repo.getWatch(id))!.errorCount).toBe(0);
  });

  it('временный сбой: повтор помогает', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec({ tripType: 'oneway', nightsMin: null, nightsMax: null }));
    h.provider.error = new ProviderError('timeout', 'timeout');
    h.provider.failTimes = 1;
    await runTick(h.svc());
    expect((await h.repo.getWatch(id))!.errorCount).toBe(0);
  });
});

describe('tick: бюджет и round-robin (SPEC §9)', () => {
  it('watch, не влезшие в бюджет запросов, проверяются следующим тиком', async () => {
    const { h, user } = await setup();
    // 2 × 2 пары × 3 месяца = 12 запросов на watch; бюджет тика — 24
    const wide = { tripType: 'oneway' as const, nightsMin: null, nightsMax: null, departFrom: '2026-10-01', departTo: '2026-12-31' };
    const ids = [];
    for (const dest of [['IST', 'AYT'], ['DXB', 'LED'], ['KZN', 'AYT']]) {
      ids.push(await h.watch(user.id, spec({ ...wide, origins: ['MOW', 'LED'].filter((o) => !dest.includes(o)).concat(dest.includes('LED') ? ['KZN'] : []), destinations: dest })));
    }
    const r1 = await runTick(h.svc());
    expect(r1.checks?.checked).toHaveLength(2);
    expect(r1.checks?.deferred).toHaveLength(1);
    expect(h.provider.calls.length).toBeLessThanOrEqual(24);

    h.advance(15);
    const r2 = await runTick(h.svc());
    expect(r2.checks?.checked).toEqual(r1.checks?.deferred);
  });

  it('CPU-бюджет: оценка объёма ответов ограничивает число watch за тик, но первый берётся всегда', async () => {
    const { h, user } = await setup();
    // 7 пар «месяц вылета × месяц возврата» × 150 КБ ≈ 1 МБ > 800 КБ — всё равно проверяется (иначе ждал бы вечно)
    const huge = await h.watch(user.id, spec({ departFrom: '2026-10-01', departTo: '2027-01-20' }));
    const small = await h.watch(user.id, spec({ destinations: ['AYT'] }));
    const r1 = await runTick(h.svc());
    expect(r1.checks?.checked).toEqual([huge]);
    expect(r1.checks?.deferred).toEqual([small]);
    h.advance(15);
    const r2 = await runTick(h.svc());
    expect(r2.checks?.checked).toEqual([small]);
  });

  it('страница, где записей чуть меньше limit, — не последняя', () => {
    expect(isLastPage(192)).toBe(false);
    expect(isLastPage(150)).toBe(false);
    expect(isLastPage(149)).toBe(true);
    expect(isLastPage(0)).toBe(true);
    expect(estimateResponseBytes({ origin: 'MOW', destination: 'IST', departureAt: '2026-11', returnAt: null, oneWay: true, direct: false, currency: 'rub', market: 'ru' })).toBe(25_000);
    expect(estimateResponseBytes({ origin: 'MOW', destination: 'IST', departureAt: '2026-11', returnAt: '2026-12', oneWay: false, direct: false, currency: 'rub', market: 'ru' })).toBe(150_000);
    expect(estimateResponseBytes({ origin: 'MOW', destination: 'IST', departureAt: '2026-11-15', returnAt: '2026-12', oneWay: false, direct: false, currency: 'rub', market: 'ru' })).toBe(50_000);
  });

  it('subrequests одного тика укладываются в лимит 50', async () => {
    const { h, user } = await setup();
    for (let i = 0; i < 20; i++) await h.watch(user.id, spec({ maxPrice: 20000 + i, departFrom: '2026-10-01', departTo: '2026-11-30' }));
    h.provider.offers = [offer({ price: 8000 })];
    const svc = h.svc();
    await runTick(svc);
    // внешние fetch в тестах идут через фейки, поэтому считаем D1 + API + Telegram
    const used = svc.repo.calls + h.provider.calls.length + h.messenger.sent.length;
    expect(used).toBeLessThanOrEqual(50);
  });
});

describe('доставка: тихие часы, лимит, блокировка (SPEC §7)', () => {
  it('в тихие часы уведомление копится и приходит дайджестом после', async () => {
    const { h, user } = await setup('2026-09-28T21:30:00Z', { quietFrom: '23:00', quietTo: '08:00' }); // 00:30 МСК
    await h.watch(user.id, spec());
    h.provider.offers = [offer({ price: 9000 })];
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(0);
    expect(h.rows("SELECT deferred, status FROM outbox WHERE kind = 'alert'")).toEqual([{ deferred: 'quiet', status: 'pending' }]);

    h.advance(60 * 7 + 40); // 08:10 МСК
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(1);
    expect(h.messenger.sent[0]!.text).toContain('Отложенные уведомления (1)');
    expect(h.rows("SELECT status FROM outbox WHERE kind = 'alert'")).toEqual([{ status: 'sent' }]);
  });

  it('очень выгодная цена в тихие часы — сразу, но без звука', async () => {
    const { h, user } = await setup('2026-09-28T21:30:00Z', { quietFrom: '23:00', quietTo: '08:00' });
    await h.watch(user.id, spec({ maxPrice: 10000 }));
    h.provider.offers = [offer({ price: 6900 })];
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(1);
    expect(h.messenger.sent[0]!.opts.silent).toBe(true);
  });

  it('дневной лимит: остальное — дайджестом завтра, одно предупреждение', async () => {
    const { h, user } = await setup(DAY, { cap: 1 });
    await h.watch(user.id, spec());
    await h.watch(user.id, spec({ destinations: ['AYT'] }));
    await h.watch(user.id, spec({ destinations: ['DXB'] }));
    h.provider.offers = [offer({ price: 9000 }), offer({ price: 9000, destAirport: 'AYT' }), offer({ price: 9000, destAirport: 'DXB' })];
    await runTick(h.svc());
    h.advance(15); // третий watch не влез в CPU-бюджет первого тика
    await runTick(h.svc());
    expect(h.messenger.texts().filter((t) => t.includes('💰'))).toHaveLength(1);
    expect(h.messenger.texts().filter((t) => t.includes('Дневной лимит'))).toHaveLength(1);
    expect(h.rows("SELECT COUNT(*) AS n FROM outbox WHERE deferred = 'cap' AND status = 'pending'")[0]).toEqual({ n: 2 });

    // на следующий день (после полуночи по Москве) — один дайджест
    h.now = new Date('2026-09-29T07:00:00Z');
    h.provider.offers = [];
    await runTick(h.svc());
    const digest = h.messenger.texts().filter((t) => t.includes('Отложенные уведомления (2)'));
    expect(digest).toHaveLength(1);
  });

  it('пользователь заблокировал бота → очередь сброшена, проверки остановлены', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec());
    h.provider.offers = [offer({ price: 9000 })];
    h.messenger.next = [{ ok: false, kind: 'blocked', description: 'Forbidden: bot was blocked by the user' }];
    await runTick(h.svc());
    expect((await h.repo.getUserById(user.id))!.isBlocked).toBe(true);
    expect(h.rows("SELECT status FROM outbox")).toEqual([{ status: 'dropped' }]);
    h.advance(61);
    const r = await runTick(h.svc());
    expect(r.checks).toBeNull();
    expect((await h.repo.getWatch(id))!.status).toBe('active');
  });

  it('временная ошибка Telegram — сообщение уйдёт следующим тиком', async () => {
    const { h, user } = await setup();
    await h.watch(user.id, spec());
    h.provider.offers = [offer({ price: 9000 })];
    h.messenger.next = [{ ok: false, kind: 'transient', description: 'HTTP 502' }];
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(0);
    expect(h.rows('SELECT status, attempts FROM outbox')).toEqual([{ status: 'pending', attempts: 1 }]);
    h.advance(15);
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(1);
  });

  it('flood wait (429 от Telegram) — останавливаем отправку, ничего не теряем', async () => {
    const { h, user } = await setup();
    await h.watch(user.id, spec());
    await h.watch(user.id, spec({ destinations: ['AYT'] }));
    h.provider.offers = [offer({ price: 9000 }), offer({ price: 9000, destAirport: 'AYT' })];
    h.messenger.next = [{ ok: false, kind: 'retry_after', retryAfterSec: 30 }];
    const r = await runTick(h.svc());
    expect(r.dispatch.floodWaitSec).toBe(30);
    expect(h.rows("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'")[0]).toEqual({ n: 2 });
    h.advance(15);
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(2);
  });
});

describe('авто-режим и бутстрап (SPEC §6)', () => {
  it('холодный старт: baseline из календаря цен, low confidence требует −30%', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec({ priceMode: 'auto', maxPrice: null }));
    h.provider.calendarPoints = [10000, 10000, 10000, 11000, 9000].map((price, i) => ({ departDate: `2026-11-1${i}`, price }));
    h.provider.offers = [offer({ price: 7500 })]; // −25% — мало для low confidence
    await runTick(h.svc());
    let w = (await h.repo.getWatch(id))!;
    expect(w.bootstrapBaseline).toBe(10000);
    expect(w.bootstrapAt).not.toBeNull();
    expect(h.messenger.sent).toHaveLength(0);

    h.advance(61);
    h.provider.offers = [offer({ price: 6900, flightNumber: '1' })];
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(1);
    expect(h.messenger.sent[0]!.text).toContain('типичной цены по календарю');
    // бутстрап выполнен один раз
    expect(h.provider.calendarCalls.length).toBeGreaterThan(0);
    const calendarCalls = h.provider.calendarCalls.length;
    h.advance(61);
    await runTick(h.svc());
    expect(h.provider.calendarCalls.length).toBe(calendarCalls);
    w = (await h.repo.getWatch(id))!;
    expect(w.lastMinPrice).toBe(6900);
  });

  it('с историей ≥ 5 дней — медиана daily_min и причина в тексте', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec({ priceMode: 'auto', maxPrice: null }));
    for (let i = 1; i <= 7; i++) {
      h.db.raw.prepare('INSERT INTO daily_min (watch_id, day, min_price) VALUES (?, ?, ?)').run(id, `2026-09-${String(28 - i).padStart(2, '0')}`, 11600);
    }
    h.provider.offers = [offer({ price: 8450 })];
    await runTick(h.svc());
    expect(h.provider.calendarCalls).toHaveLength(0); // история уже есть — бутстрап не нужен
    expect(h.messenger.sent[0]!.text).toContain('на 27% ниже медианы за 21 день (11 600 ₽)');
    expect(h.messenger.sent[0]!.text).toContain('новый минимум');
  });
});

describe('ручная проверка и точка отсчёта (SPEC §8.3)', () => {
  it('после создания — текущий минимум, даже если он выше порога', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec({ maxPrice: 5000 }));
    h.provider.offers = [offer({ price: 12000 }), offer({ price: 13000, flightNumber: '2' })];
    await runInitialCheck(h.svc(), id, user, 'initial');
    expect(h.messenger.sent).toHaveLength(1);
    expect(h.messenger.sent[0]!.text).toContain(`Наблюдение #${id} создано`);
    expect(h.messenger.sent[0]!.text).toContain('Точка отсчёта');
    expect(h.messenger.sent[0]!.text).toContain('12 000');
  });

  it('если текущая цена уже ниже порога — повторного алерта в тике не будет', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec());
    h.provider.offers = [offer({ price: 9000 })];
    await runInitialCheck(h.svc(), id, user, 'initial');
    h.advance(61);
    await runTick(h.svc());
    expect(h.messenger.sent).toHaveLength(1);
  });

  it('ничего не найдено — честно говорим об этом', async () => {
    const { h, user } = await setup();
    const id = await h.watch(user.id, spec());
    await runInitialCheck(h.svc(), id, user, 'manual');
    expect(h.messenger.sent[0]!.text).toContain('нет подходящих билетов');
  });
});

describe('daily (SPEC §9)', () => {
  it('закрывает watch с прошедшим окном, чистит историю, шлёт heartbeat', async () => {
    const h = new Harness('2026-12-02T03:07:00Z');
    const user = await h.user();
    const admin = await h.user({ tgUserId: 9, username: 'admin' });
    const past = await h.watch(user.id, spec({ departFrom: '2026-11-15', departTo: '2026-11-30' }));
    const future = await h.watch(user.id, spec({ departFrom: '2026-12-15', departTo: '2026-12-30' }));
    h.db.raw.prepare('INSERT INTO daily_min (watch_id, day, min_price) VALUES (?, ?, ?), (?, ?, ?)').run(past, '2026-10-01', 9100, past, '2026-10-02', 8700);
    h.db.raw
      .prepare('INSERT INTO observations (watch_id, observed_at, origin_airport, destination_airport, depart_date, price) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)')
      .run(past, '2026-08-01T00:00:00Z', 'SVO', 'IST', '2026-11-20', 9000, past, '2026-11-30T00:00:00Z', 'SVO', 'IST', '2026-11-20', 9000);
    h.db.raw.prepare("INSERT INTO counters (day, name, value) VALUES ('2026-12-01', 'api_requests', 57), ('2026-12-01', 'api_errors', 2)").run();

    const r = await runDaily(h.svc());
    expect(r.expired).toEqual([past]);
    expect((await h.repo.getWatch(past))!.status).toBe('expired');
    expect((await h.repo.getWatch(future))!.status).toBe('active');
    const toUser = h.messenger.sent.filter((m) => m.chatId === user.chatId);
    expect(toUser).toHaveLength(1);
    expect(toUser[0]!.text).toContain('завершено');
    expect(toUser[0]!.text).toContain('8 700 ₽');
    const hb = h.messenger.sent.filter((m) => m.chatId === admin.chatId);
    expect(hb).toHaveLength(1);
    expect(hb[0]!.text).toContain('активных watch: 1');
    expect(hb[0]!.text).toContain('запросов к API: 57, ошибок: 2');
    expect(h.rows('SELECT observed_at FROM observations')).toEqual([{ observed_at: '2026-11-30T00:00:00Z' }]);
    expect(r.heartbeatSent).toBe(true);
  });

  it('watch по часовому поясу пользователя: во Владивостоке день наступает раньше', async () => {
    const h = new Harness('2026-11-30T15:30:00Z'); // во Владивостоке уже 1 декабря
    const vvo = await h.user({ tgUserId: 5, username: 'bob', tz: 'Asia/Vladivostok' });
    const msk = await h.user({ tgUserId: 6, username: 'alice' });
    const a = await h.watch(vvo.id, spec({ departTo: '2026-11-30' }));
    const b = await h.watch(msk.id, spec({ departTo: '2026-11-30' }));
    const r = await runDaily(h.svc());
    expect(r.expired).toEqual([a]);
    expect((await h.repo.getWatch(b))!.status).toBe('active');
  });
});
