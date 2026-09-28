import { fileURLToPath } from 'node:url';
import { queryKey } from '../src/core/queryPlanner.ts';
import type { CalendarQuery } from '../src/core/queryPlanner.ts';
import type { FareQuery, Offer, User, WatchSpec } from '../src/core/types.ts';
import { NodeSqliteDatabase } from '../src/db/nodeSqlite.ts';
import { Repo } from '../src/db/repo.ts';
import { loadConfig, type AppConfig } from '../src/platform/env.ts';
import { silentLogger } from '../src/platform/log.ts';
import type { Messenger, SendOptions, SendResult } from '../src/platform/telegram.ts';
import type { Place } from '../src/providers/autocomplete.ts';
import { ProviderError, type CalendarPoint, type FareProvider, type SearchPage } from '../src/providers/FareProvider.ts';
import { createServices, type Services } from '../src/services.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export const TEST_ENV = {
  TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
  TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret_123',
  TRAVELPAYOUTS_TOKEN: 'tp_token_0123456789abcdef',
  ALLOWED_USERNAMES: 'alice, @Bob',
  ADMIN_USERNAME: 'admin',
  DEFAULT_CURRENCY: 'rub',
  MARKET: 'ru',
};

/** Провайдер-заглушка: офферы задаются тестом, фильтр по маршруту/месяцу имитирует API. */
export class FakeProvider implements FareProvider {
  readonly id = 'fake';
  offers: Offer[] = [];
  calendarPoints: CalendarPoint[] = [];
  error: ProviderError | null = null;
  /** Сколько раз подряд падать (потом — нормальные ответы). */
  failTimes = Infinity;
  calls: Array<{ key: string; page: number; limit: number }> = [];
  calendarCalls: CalendarQuery[] = [];

  async search(q: FareQuery, page: number, limit: number): Promise<SearchPage> {
    this.calls.push({ key: queryKey(q), page, limit });
    if (this.error && this.failTimes > 0) {
      this.failTimes--;
      throw this.error;
    }
    const matching = this.offers.filter((o) => routeMatches(o, q)).sort((a, b) => a.price - b.price);
    const pageOffers = matching.slice((page - 1) * limit, page * limit);
    return { offers: pageOffers, rawCount: pageOffers.length, bytes: 500 * pageOffers.length + 50 };
  }

  async calendar(q: CalendarQuery): Promise<CalendarPoint[]> {
    this.calendarCalls.push(q);
    if (this.error && this.failTimes > 0) throw this.error;
    return this.calendarPoints.filter((p) => p.departDate.startsWith(q.month));
  }
}

/** Код города → набор аэропортов (для имитации выдачи по городу). */
const CITY_AIRPORTS: Record<string, string[]> = {
  MOW: ['SVO', 'VKO', 'DME', 'MOW'],
  IST: ['IST', 'SAW'],
  LED: ['LED'],
  AYT: ['AYT'],
  DXB: ['DXB'],
  KZN: ['KZN'],
};

function inCity(airport: string, code: string): boolean {
  return (CITY_AIRPORTS[code] ?? [code]).includes(airport);
}

function routeMatches(o: Offer, q: FareQuery): boolean {
  if (!inCity(o.originAirport, q.origin) || !inCity(o.destAirport, q.destination)) return false;
  if (!o.departAt.startsWith(q.departureAt)) return false;
  if (q.oneWay) return o.returnAt === null;
  if (!o.returnAt) return false;
  return q.returnAt === null || o.returnAt.startsWith(q.returnAt);
}

export interface SentMessage {
  chatId: number;
  text: string;
  opts: SendOptions;
}

export class FakeMessenger implements Messenger {
  sent: SentMessage[] = [];
  /** Результаты для следующих отправок (по умолчанию — успех). */
  next: SendResult[] = [];
  private id = 100;

  async send(chatId: number, text: string, opts: SendOptions = {}): Promise<SendResult> {
    const r = this.next.shift() ?? { ok: true as const, messageId: this.id++ };
    if (r.ok) this.sent.push({ chatId, text, opts });
    return r;
  }

  texts(): string[] {
    return this.sent.map((m) => m.text);
  }
}

export class Harness {
  readonly db: NodeSqliteDatabase;
  readonly repo: Repo;
  readonly cfg: AppConfig;
  readonly provider = new FakeProvider();
  readonly messenger = new FakeMessenger();
  places: Record<string, Place[]> = {};
  waits: Promise<unknown>[] = [];
  now: Date;

  constructor(now: string, env: Record<string, string> = {}) {
    this.db = new NodeSqliteDatabase();
    this.db.migrate(MIGRATIONS_DIR);
    this.repo = new Repo(this.db);
    this.cfg = loadConfig({ ...TEST_ENV, ...env });
    this.now = new Date(now);
  }

  /** Новый набор сервисов — как новый вызов Worker (свой бюджет subrequests). */
  svc(): Services {
    return createServices(
      this.cfg,
      this.db,
      { waitUntil: (p) => void this.waits.push(p) },
      {
        provider: this.provider,
        messenger: this.messenger,
        log: silentLogger,
        now: () => new Date(this.now),
        searchPlaces: async (term) => this.places[term.toLowerCase()] ?? [],
        fetch: (async () => {
          throw new Error('network is disabled in tests');
        }) as typeof fetch,
      },
    );
  }

  advance(minutes: number): void {
    this.now = new Date(this.now.getTime() + minutes * 60_000);
  }

  async flush(): Promise<void> {
    while (this.waits.length) await Promise.all(this.waits.splice(0));
  }

  async user(p: { tgUserId?: number; username?: string; tz?: string; quietFrom?: string | null; quietTo?: string | null; cap?: number } = {}): Promise<User> {
    const u = await this.repo.upsertUserOnStart({
      tgUserId: p.tgUserId ?? 1001,
      chatId: p.tgUserId ?? 1001,
      username: p.username ?? 'alice',
      now: this.now.toISOString(),
      tz: p.tz ?? 'Europe/Moscow',
      currency: 'rub',
      cap: p.cap ?? 20,
    });
    if (p.quietFrom !== undefined || p.quietTo !== undefined) {
      await this.repo.updateUserSettings(u.id, { quietFrom: p.quietFrom ?? null, quietTo: p.quietTo ?? null }, this.now.toISOString());
    }
    return (await this.repo.getUserById(u.id))!;
  }

  async watch(userId: number, s: WatchSpec, name = 'test'): Promise<number> {
    return this.repo.createWatch(userId, name, s, this.now.toISOString(), 60);
  }

  rows<T = Record<string, unknown>>(sql: string, ...args: Array<string | number | null>): T[] {
    return this.db.raw.prepare(sql).all(...args) as T[];
  }
}
