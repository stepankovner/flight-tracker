import { readFileSync } from 'node:fs';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.ts';
import { parseTimeZone } from '../src/bot/commands/settings.ts';
import { sparkline } from '../src/bot/commands/history.ts';
import { handleFetch, handleScheduled } from '../src/index.ts';
import { webhookPath } from '../src/platform/env.ts';
import { parsePlaces, type Place } from '../src/providers/autocomplete.ts';
import { Harness, TEST_ENV } from './harness.ts';
import { offer } from './helpers.ts';

const BOT_INFO = {
  id: 42,
  is_bot: true,
  first_name: 'FareWatch',
  username: 'farewatch_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as unknown as UserFromGetMe;

const moscow = parsePlaces(JSON.parse(readFileSync(new URL('./fixtures/places2_moscow.json', import.meta.url), 'utf8')));
const istanbul: Place[] = [
  { kind: 'city', code: 'IST', name: 'Стамбул', cityCode: 'IST', cityName: 'Стамбул', countryName: 'Турция', weight: 900000 },
  { kind: 'airport', code: 'SAW', name: 'Сабиха Гёкчен', cityCode: 'IST', cityName: 'Стамбул', countryName: 'Турция', weight: 100000 },
];

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

const ALICE = { id: 1001, is_bot: false, first_name: 'Alice', username: 'alice' };
const EVE = { id: 666, is_bot: false, first_name: 'Eve', username: 'eve' };

class BotDriver {
  calls: ApiCall[] = [];
  private updateId = 1;
  readonly h: Harness;
  constructor(h: Harness) {
    this.h = h;
  }

  /** Каждый апдейт — как отдельный вызов Worker: свои сервисы и бот. */
  async handle(update: Omit<Update, 'update_id'>): Promise<void> {
    const bot = createBot(this.h.svc(), BOT_INFO);
    bot.api.config.use(async (_prev, method, payload) => {
      this.calls.push({ method, payload: payload as Record<string, unknown> });
      const p = payload as { chat_id?: number; text?: string };
      if (method === 'sendMessage' || method === 'editMessageText') {
        return { ok: true, result: { message_id: this.calls.length, date: 0, chat: { id: p.chat_id ?? 1, type: 'private' }, text: p.text ?? '' } } as never;
      }
      return { ok: true, result: true } as never;
    });
    await bot.handleUpdate({ update_id: this.updateId++, ...update } as Update);
    await this.h.flush();
  }

  text(text: string, from = ALICE) {
    const entities = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] : undefined;
    return this.handle({ message: { message_id: this.updateId, date: 0, chat: { id: from.id, type: 'private', first_name: from.first_name }, from, text, entities } } as never);
  }

  press(data: string, from = ALICE) {
    return this.handle({
      callback_query: {
        id: String(this.updateId),
        from,
        chat_instance: 'x',
        data,
        message: { message_id: 77, date: 0, chat: { id: from.id, type: 'private', first_name: from.first_name }, text: 'old' },
      },
    } as never);
  }

  /** Тексты, показанные пользователю (новые сообщения и правки). */
  shown(): string[] {
    return this.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => String(c.payload.text));
  }

  last(): ApiCall {
    const c = [...this.calls].reverse().find((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
    if (!c) throw new Error('no messages');
    return c;
  }

  lastText(): string {
    return String(this.last().payload.text);
  }

  buttons(): string[] {
    const kb = (this.last().payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } | undefined)?.inline_keyboard ?? [];
    return kb.flat().map((b) => b.callback_data ?? b.text);
  }
}

async function setup() {
  const h = new Harness('2026-09-28T09:00:00Z');
  h.places = { москва: moscow, стамбул: istanbul };
  return { h, d: new BotDriver(h) };
}

describe('доступ (SPEC §8.1)', () => {
  it('разрешённый username привязывается по /start, чужой получает вежливый отказ', async () => {
    const { h, d } = await setup();
    await d.text('/start');
    expect(d.lastText()).toContain('FareWatch');
    const alice = await h.repo.getUserByTgId(ALICE.id);
    expect(alice).toMatchObject({ chatId: ALICE.id, username: 'alice', boundUsername: 'alice' });

    await d.text('/start', EVE);
    expect(d.lastText()).toBe('Извини, это закрытый бот.');
    expect(await h.repo.getUserByTgId(EVE.id)).toBeNull();
    await d.press('m:list', EVE);
    expect(d.calls.at(-1)!.method).toBe('answerCallbackQuery');
  });

  it('после смены username работаем по tg_user_id', async () => {
    const { h, d } = await setup();
    await d.text('/start');
    await d.text('/help', { ...ALICE, username: 'alice_new' });
    expect(d.lastText()).toContain('Форматы ввода');
    const u = await h.repo.getUserByTgId(ALICE.id);
    expect(u).toMatchObject({ username: 'alice_new', boundUsername: 'alice' });
  });

  it('username в allowlist нечувствителен к регистру и @', async () => {
    const { d } = await setup();
    await d.text('/start', { id: 5, is_bot: false, first_name: 'Bob', username: 'BOB' });
    expect(d.lastText()).toContain('FareWatch');
  });
});

describe('мастер /new (SPEC §8.3)', () => {
  it('полный проход: создание, подсказка цены, первая проверка', async () => {
    const { h, d } = await setup();
    h.provider.offers = [
      offer({ price: 9000, transfersOut: 0, transfersBack: 0 }),
      offer({ price: 7000, transfersOut: 1, flightNumber: '2' }), // отсеется фильтром «только прямые»
    ];
    await d.text('/new');
    expect(d.lastText()).toContain('Откуда летим');

    await d.text('Москва');
    expect(d.shown().some((t) => t.includes('🛫 Откуда: Москва'))).toBe(true);
    expect(d.lastText()).toContain('Куда?');

    await d.text('Стамбул');
    expect(d.lastText()).toContain('Тип поездки');

    await d.press('w:t:rt');
    expect(d.lastText()).toContain('Даты вылета');

    await d.text('абракадабра');
    expect(d.lastText()).toContain('Не понял даты');

    await d.text('15.11-30.11');
    expect(d.lastText()).toContain('Сколько ночей');

    await d.press('w:n:6-9');
    expect(d.lastText()).toContain('Фильтры');
    await d.press('w:f:d');
    expect(d.buttons()).toContain('w:f:d');
    expect(JSON.stringify(d.last().payload.reply_markup)).toContain('Только прямые: да');

    await d.press('w:f:ok');
    expect(d.lastText()).toContain('Сейчас самое дешёвое в твоём окне: <b>9 000 ₽</b>');

    await d.press('w:pm:threshold');
    expect(d.buttons()).toEqual(expect.arrayContaining(['w:pv:7200', 'w:pv:8100', 'w:pv:9000']));
    await d.text('10к');
    expect(d.lastText()).toContain('Проверь наблюдение');
    expect(d.lastText()).toContain('💰 до 10 000 ₽');
    expect(d.buttons()).toContain('w:ok');

    const providerCalls = h.provider.calls.length;
    await d.press('w:ok');
    expect(d.lastText()).toContain('Наблюдение #1 создано');
    const w = await h.repo.getWatch(1);
    expect(w).toMatchObject({
      origins: ['MOW'],
      destinations: ['IST'],
      tripType: 'roundtrip',
      departFrom: '2026-11-15',
      departTo: '2026-11-30',
      nightsMin: 6,
      nightsMax: 9,
      directOnly: true,
      priceMode: 'threshold',
      maxPrice: 10000,
      status: 'active',
    });
    // первая проверка взяла ответы из кэша подсказки
    expect(h.provider.calls.length).toBe(providerCalls);
    expect(h.messenger.sent).toHaveLength(1);
    expect(h.messenger.sent[0]!.text).toContain('Точка отсчёта');
    expect(h.messenger.sent[0]!.text).toContain('ниже твоего порога');
    expect(await h.repo.getWizard(ALICE.id)).toBeNull();
  });

  it('неоднозначный город → выбор кнопкой; «Назад» и «Отмена»', async () => {
    const { h, d } = await setup();
    h.places['сан-хосе'] = [
      { kind: 'city', code: 'SJO', name: 'Сан-Хосе', cityCode: 'SJO', cityName: 'Сан-Хосе', countryName: 'Коста-Рика', weight: 1000 },
      { kind: 'city', code: 'SJC', name: 'Сан-Хосе', cityCode: 'SJC', cityName: 'Сан-Хосе', countryName: 'США', weight: 900 },
    ];
    await d.text('/new');
    await d.text('Москва');
    await d.text('Сан-Хосе');
    expect(d.lastText()).toContain('Уточни');
    expect(d.buttons()).toEqual(['w:p:0', 'w:p:1', 'w:b', 'w:x']);
    await d.press('w:p:1');
    expect(d.lastText()).toContain('Тип поездки');
    await d.press('w:t:ow');
    await d.press('w:b');
    expect(d.lastText()).toContain('Тип поездки');
    await d.press('w:x');
    expect(d.lastText()).toContain('Отменил');
    expect(await h.repo.getWizard(ALICE.id)).toBeNull();
  });

  it('неизвестный город и совпадающие пункты', async () => {
    const { d } = await setup();
    await d.text('/new');
    await d.text('Нарния');
    expect(d.lastText()).toContain('Не нашёл');
    await d.text('Москва');
    await d.text('Москва');
    expect(d.shown().some((t) => t.includes('совпадают'))).toBe(true);
  });

  it('авто-режим в одну сторону; правка раздела со сводки', async () => {
    const { h, d } = await setup();
    await d.text('/new');
    await d.text('Москва');
    await d.text('Стамбул');
    await d.press('w:t:ow');
    await d.text('ноябрь');
    expect(d.lastText()).toContain('Фильтры'); // для «в одну сторону» ночи не спрашиваем
    await d.press('w:f:w');
    await d.press('w:wd:5');
    await d.press('w:wd:6');
    await d.press('w:wd:ok');
    await d.press('w:f:a');
    await d.press('w:f:ok');
    await d.press('w:pm:auto');
    expect(d.lastText()).toContain('вылет: Пт, Сб');
    expect(d.lastText()).toContain('2 взрослых');
    await d.press('w:e:dt');
    await d.text('декабрь');
    expect(d.lastText()).toContain('вылет 1 дек – 31 дек 2026');
    await d.press('w:ok');
    expect(await h.repo.getWatch(1)).toMatchObject({ tripType: 'oneway', departFrom: '2026-12-01', priceMode: 'auto', maxPrice: null, departWeekdays: [5, 6], adults: 2 });
  });

  it('устаревший мастер', async () => {
    const { h, d } = await setup();
    await d.text('/new');
    h.advance(31);
    await d.press('w:t:rt');
    expect(d.calls.at(-1)).toMatchObject({ method: 'answerCallbackQuery', payload: { text: 'Мастер устарел — начни заново: /new' } });
    await d.text('Москва');
    expect(d.lastText()).toContain('/new');
  });
});

describe('/list и действия (SPEC §8.2)', () => {
  async function withWatch() {
    const s = await setup();
    await s.d.text('/start');
    const user = (await s.h.repo.getUserByTgId(ALICE.id))!;
    await s.h.repo.batch(s.h.repo.stmtsUpsertPlaces([...moscow, ...istanbul], s.h.now.toISOString()));
    const { spec } = await import('./helpers.ts');
    const id = await s.h.watch(user.id, spec());
    return { ...s, id, user };
  }

  it('список, пауза, возобновление, удаление', async () => {
    const { h, d, id } = await withWatch();
    await d.text('/list');
    expect(d.lastText()).toContain(`<b>#${id}</b> ▶️ Москва → Стамбул`);
    expect(d.buttons()).toEqual(expect.arrayContaining([`l:p:${id}`, `l:e:${id}`, `l:d:${id}`, `l:c:${id}`]));

    await d.press(`l:p:${id}`);
    expect((await h.repo.getWatch(id))!.status).toBe('paused');
    expect(d.lastText()).toContain('⏸');
    await d.press(`l:r:${id}`);
    expect((await h.repo.getWatch(id))!.status).toBe('active');

    await d.press(`l:d:${id}`);
    expect(d.lastText()).toContain('Удалить наблюдение');
    await d.press(`l:dy:${id}`);
    expect(await h.repo.getWatch(id)).toBeNull();
    expect(d.lastText()).toContain('Пока нет наблюдений');
  });

  it('проверка сейчас: запуск и лимит 1 раз в 5 минут', async () => {
    const { h, d, id } = await withWatch();
    h.provider.offers = [offer({ price: 11000 })];
    await d.text(`/check ${id}`);
    expect(d.shown()).toContain(`🔄 Проверяю #${id}…`);
    expect(h.messenger.sent.at(-1)!.text).toContain(`Проверка #${id}`);
    await d.press(`l:c:${id}`);
    expect(d.calls.at(-1)!.payload.text).toMatch(/через \d мин/);
    h.advance(6);
    await d.text('/check');
    expect(h.messenger.sent).toHaveLength(2);
  });

  it('кнопки уведомления: пауза, «не показывать», «показать все»', async () => {
    const { h, d, id, user } = await withWatch();
    h.provider.offers = [8000, 8100, 8200, 8300].map((price, i) => offer({ price, flightNumber: String(i) }));
    const { runTick } = await import('../src/jobs/tick.ts');
    await runTick(h.svc());
    const outboxId = Number(h.rows<{ id: number }>("SELECT id FROM outbox WHERE kind = 'alert'")[0]!.id);

    await d.press(`a:more:${outboxId}`);
    expect(d.lastText()).toContain('8 300');
    await d.press(`a:mute:${outboxId}:0`);
    expect(h.rows('SELECT muted FROM notified WHERE offer_key = ?', 'SVO|IST|2026-11-18|2026-11-25|PC|0')).toEqual([{ muted: 1 }]);
    await d.press(`a:pause:${id}`);
    expect((await h.repo.getWatch(id))!.status).toBe('paused');
    expect(user.id).toBeGreaterThan(0);
  });

  it('/history', async () => {
    const { h, d, id } = await withWatch();
    h.db.raw.prepare('INSERT INTO daily_min (watch_id, day, min_price) VALUES (?, ?, ?), (?, ?, ?)').run(id, '2026-09-27', 9000, id, '2026-09-20', 12000);
    await d.text(`/history ${id}`);
    expect(d.lastText()).toContain('мин <b>9 000 ₽</b>');
    expect(d.lastText()).toContain('27 сен (вс) — 9 000 ₽');
    await d.text('/history 999');
    expect(d.lastText()).toContain('не найдено');
  });
});

describe('/settings', () => {
  it('часовой пояс, тихие часы, лимит', async () => {
    const { h, d } = await setup();
    await d.text('/settings');
    expect(d.lastText()).toContain('Europe/Moscow');
    await d.press('s:tz:Asia/Novosibirsk');
    expect(d.lastText()).toContain('Asia/Novosibirsk');
    await d.press('s:tz');
    await d.text('UTC+5');
    expect((await h.repo.getUserByTgId(ALICE.id))!.tz).toBe('Etc/GMT-5');
    await d.press('s:q');
    await d.text('23:00-07:30');
    expect(await h.repo.getUserByTgId(ALICE.id)).toMatchObject({ quietFrom: '23:00', quietTo: '07:30' });
    await d.press('s:cap:5');
    expect((await h.repo.getUserByTgId(ALICE.id))!.dailyAlertCap).toBe(5);
    await d.press('s:qoff');
    expect((await h.repo.getUserByTgId(ALICE.id))!.quietFrom).toBeNull();
  });

  it('parseTimeZone', () => {
    expect(parseTimeZone('UTC+3')).toBe('Etc/GMT-3');
    expect(parseTimeZone('-5')).toBe('Etc/GMT+5');
    expect(parseTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(parseTimeZone('utc')).toBe('Etc/UTC');
    expect(parseTimeZone('Moon/Base')).toBeNull();
    expect(parseTimeZone('UTC+20')).toBeNull();
  });
});

describe('прочее', () => {
  it('sparkline', () => {
    expect(sparkline([1, null, 8])).toBe('▁·█');
    expect(sparkline([5, 5])).toBe('▄▄');
    expect(sparkline([null])).toBe('');
  });

  it('незнакомые команды и текст вне мастера', async () => {
    const { d } = await setup();
    await d.text('/foo');
    expect(d.lastText()).toContain('Не знаю такой команды');
    await d.text('привет');
    expect(d.lastText()).toContain('/new');
  });

  it('/status только для админа', async () => {
    const { d } = await setup();
    await d.text('/status');
    expect(d.lastText()).toContain('только для администратора');
    await d.text('/status', { id: 9, is_bot: false, first_name: 'Admin', username: 'admin' });
    expect(d.lastText()).toContain('Статус');
  });
});

describe('Worker: роутинг (SPEC §10)', () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness('2026-09-28T09:00:00Z');
    vi.stubGlobal('fetch', async () => new Response('blocked in tests', { status: 599 }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const env = () => ({ ...TEST_ENV, DB: h.db, DRY_RUN: '1', BOT_INFO: JSON.stringify(BOT_INFO) });
  const ctx = { waitUntil: () => undefined };

  it('всё, кроме POST на секретный путь с верным заголовком, — 404', async () => {
    const path = await webhookPath(TEST_ENV.TELEGRAM_WEBHOOK_SECRET);
    expect(path).toMatch(/^\/tg\/[0-9a-f]{32}$/);
    const base = 'https://farewatch.example.workers.dev';
    const body = JSON.stringify({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 1001, type: 'private' }, from: ALICE, text: '/help' } });
    const headers = { 'X-Telegram-Bot-Api-Secret-Token': TEST_ENV.TELEGRAM_WEBHOOK_SECRET, 'Content-Type': 'application/json' };
    expect((await handleFetch(new Request(`${base}/`), env() as never, ctx)).status).toBe(404);
    expect((await handleFetch(new Request(`${base}${path}`), env() as never, ctx)).status).toBe(404);
    expect((await handleFetch(new Request(`${base}/tg/wrong`, { method: 'POST', body, headers }), env() as never, ctx)).status).toBe(404);
    expect((await handleFetch(new Request(`${base}${path}`, { method: 'POST', body, headers: { ...headers, 'X-Telegram-Bot-Api-Secret-Token': 'nope' } }), env() as never, ctx)).status).toBe(404);
    const ok = await handleFetch(new Request(`${base}${path}`, { method: 'POST', body, headers }), env() as never, ctx);
    expect(ok.status).toBe(200);
    expect(await h.repo.getUserByTgId(ALICE.id)).not.toBeNull();
  });

  it('неверная конфигурация → 500 без утечки значений', async () => {
    const res = await handleFetch(new Request('https://x.dev/tg/abc', { method: 'POST' }), { DB: h.db } as never, ctx);
    expect(res.status).toBe(500);
  });

  it('cron: */15 → tick, 7 3 * * * → daily', async () => {
    await handleScheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env() as never, ctx);
    expect((await h.repo.getKv(['last_tick_at'])).has('last_tick_at')).toBe(true);
    await handleScheduled({ cron: '7 3 * * *', scheduledTime: Date.now() }, env() as never, ctx);
    expect(h.rows("SELECT name FROM counters WHERE name = 'ticks'")).toHaveLength(1);
  });
});
