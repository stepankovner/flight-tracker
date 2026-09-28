import type { NameBook, PlaceName } from '../core/format.ts';
import type { DailyMinPoint } from '../core/priceDetector.ts';
import type { Offer, User, Watch, WatchSpec, WatchStatus } from '../core/types.ts';
import type { Place } from '../providers/autocomplete.ts';
import type { SqlDatabase, SqlStatement, SqlValue } from './sql.ts';

// Все SQL-запросы проекта — только здесь.

type Row = Record<string, unknown>;

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const parseJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Разбить массив на куски (лимит D1 — 100 bind-параметров на выражение). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function rowToUser(r: Row): User {
  return {
    id: Number(r.id),
    tgUserId: Number(r.tg_user_id),
    chatId: Number(r.chat_id),
    username: str(r.username),
    boundUsername: str(r.bound_username),
    tz: String(r.tz),
    currency: String(r.currency),
    quietFrom: str(r.quiet_from),
    quietTo: str(r.quiet_to),
    dailyAlertCap: Number(r.daily_alert_cap),
    isBlocked: Number(r.is_blocked) === 1,
  };
}

export function rowToWatch(r: Row): Watch {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    name: String(r.name),
    status: String(r.status) as WatchStatus,
    origins: parseJson<string[]>(r.origins, []),
    destinations: parseJson<string[]>(r.destinations, []),
    tripType: r.trip_type === 'roundtrip' ? 'roundtrip' : 'oneway',
    departFrom: String(r.depart_from),
    departTo: String(r.depart_to),
    nightsMin: num(r.nights_min),
    nightsMax: num(r.nights_max),
    returnTo: str(r.return_to),
    departWeekdays: parseJson<number[] | null>(r.depart_weekdays, null),
    returnWeekdays: parseJson<number[] | null>(r.return_weekdays, null),
    directOnly: Number(r.direct_only) === 1,
    maxTransfers: num(r.max_transfers),
    maxDurationMin: num(r.max_duration_min),
    excludeAirlines: parseJson<string[] | null>(r.exclude_airlines, null),
    departTimeFrom: str(r.depart_time_from),
    departTimeTo: str(r.depart_time_to),
    adults: Number(r.adults ?? 1),
    priceMode: String(r.price_mode) as Watch['priceMode'],
    maxPrice: num(r.max_price),
    autoSensitivity: Number(r.auto_sensitivity ?? 0.2),
    checkIntervalMin: Number(r.check_interval_min ?? 60),
    lastCheckedAt: str(r.last_checked_at),
    lastError: str(r.last_error),
    errorCount: Number(r.error_count ?? 0),
    bootstrapBaseline: num(r.bootstrap_baseline),
    bootstrapAt: str(r.bootstrap_at),
    lastMinPrice: num(r.last_min_price),
    lastMinOffer: parseJson<Offer | null>(r.last_min_offer, null),
    lastManualCheckAt: str(r.last_manual_check_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function specColumns(spec: WatchSpec): Record<string, SqlValue> {
  return {
    origins: json(spec.origins),
    destinations: json(spec.destinations),
    trip_type: spec.tripType,
    depart_from: spec.departFrom,
    depart_to: spec.departTo,
    nights_min: spec.tripType === 'roundtrip' ? spec.nightsMin : null,
    nights_max: spec.tripType === 'roundtrip' ? spec.nightsMax : null,
    return_to: spec.tripType === 'roundtrip' ? spec.returnTo : null,
    depart_weekdays: spec.departWeekdays?.length ? json(spec.departWeekdays) : null,
    return_weekdays: spec.returnWeekdays?.length ? json(spec.returnWeekdays) : null,
    direct_only: spec.directOnly ? 1 : 0,
    max_transfers: spec.maxTransfers,
    max_duration_min: spec.maxDurationMin,
    exclude_airlines: spec.excludeAirlines?.length ? json(spec.excludeAirlines) : null,
    depart_time_from: spec.departTimeFrom,
    depart_time_to: spec.departTimeTo,
    adults: spec.adults,
    price_mode: spec.priceMode,
    max_price: spec.priceMode === 'auto' ? null : spec.maxPrice,
    auto_sensitivity: spec.autoSensitivity,
  };
}

export interface WatchWithUser {
  watch: Watch;
  user: User;
}

export type OutboxKind = 'alert' | 'reply' | 'system' | 'digest' | 'cap_notice';

export interface OutboxRow {
  id: number;
  userId: number;
  watchId: number | null;
  kind: OutboxKind;
  payload: string;
  urgent: boolean;
  status: 'pending' | 'sent' | 'dropped';
  deferred: 'quiet' | 'cap' | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

function rowToOutbox(r: Row): OutboxRow {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    watchId: num(r.watch_id),
    kind: String(r.kind) as OutboxKind,
    payload: String(r.payload),
    urgent: Number(r.urgent) === 1,
    status: String(r.status) as OutboxRow['status'],
    deferred: (str(r.deferred) as OutboxRow['deferred']) ?? null,
    attempts: Number(r.attempts ?? 0),
    createdAt: String(r.created_at),
    sentAt: str(r.sent_at),
  };
}

export interface NotifiedRow {
  watchId: number;
  offerKey: string;
  lastPrice: number;
  muted: boolean;
}

export class Repo {
  readonly db: SqlDatabase;
  /** Сколько обращений к D1 сделано этим экземпляром (для бюджета subrequests). */
  calls = 0;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  private async first<T = Row>(sql: string, ...values: SqlValue[]): Promise<T | null> {
    this.calls++;
    return this.db.prepare(sql).bind(...values).first<T>();
  }

  private async all<T = Row>(sql: string, ...values: SqlValue[]): Promise<T[]> {
    this.calls++;
    return (await this.db.prepare(sql).bind(...values).all<T>()).results;
  }

  private async run(sql: string, ...values: SqlValue[]) {
    this.calls++;
    return (await this.db.prepare(sql).bind(...values).run()).meta;
  }

  stmt(sql: string, ...values: SqlValue[]): SqlStatement {
    return this.db.prepare(sql).bind(...values);
  }

  /** Выполнить пачку выражений одной транзакцией (1 subrequest). */
  async batch(statements: SqlStatement[]): Promise<Array<{ results: Row[] }>> {
    if (statements.length === 0) return [];
    this.calls++;
    return this.db.batch<Row>(statements);
  }

  // ---------- users ----------

  async getUserByTgId(tgUserId: number): Promise<User | null> {
    const r = await this.first('SELECT * FROM users WHERE tg_user_id = ?', tgUserId);
    return r ? rowToUser(r) : null;
  }

  async getUserById(id: number): Promise<User | null> {
    const r = await this.first('SELECT * FROM users WHERE id = ?', id);
    return r ? rowToUser(r) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const u = username.toLowerCase();
    const r = await this.first(
      'SELECT * FROM users WHERE username = ? OR bound_username = ? ORDER BY (username = ?) DESC LIMIT 1',
      u,
      u,
      u,
    );
    return r ? rowToUser(r) : null;
  }

  /** Привязка при /start: создаёт пользователя или обновляет chat_id/username, снимает блокировку. */
  async upsertUserOnStart(p: { tgUserId: number; chatId: number; username: string | null; now: string; tz: string; currency: string; cap: number }): Promise<User> {
    const username = p.username?.toLowerCase() ?? null;
    this.calls++;
    const r = await this.db
      .prepare(
        `INSERT INTO users (tg_user_id, chat_id, username, bound_username, tz, currency, daily_alert_cap, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET chat_id = excluded.chat_id, username = excluded.username,
           bound_username = COALESCE(users.bound_username, excluded.bound_username), is_blocked = 0, updated_at = excluded.updated_at
         RETURNING *`,
      )
      .bind(p.tgUserId, p.chatId, username, username, p.tz, p.currency, p.cap, p.now, p.now)
      .first<Row>();
    return rowToUser(r!);
  }

  async updateUsername(userId: number, username: string | null, now: string): Promise<void> {
    await this.run('UPDATE users SET username = ?, updated_at = ? WHERE id = ?', username?.toLowerCase() ?? null, now, userId);
  }

  async updateUserSettings(
    userId: number,
    patch: Partial<Pick<User, 'tz' | 'quietFrom' | 'quietTo' | 'dailyAlertCap'>>,
    now: string,
  ): Promise<void> {
    const sets: string[] = [];
    const vals: SqlValue[] = [];
    if (patch.tz !== undefined) (sets.push('tz = ?'), vals.push(patch.tz));
    if (patch.quietFrom !== undefined) (sets.push('quiet_from = ?'), vals.push(patch.quietFrom));
    if (patch.quietTo !== undefined) (sets.push('quiet_to = ?'), vals.push(patch.quietTo));
    if (patch.dailyAlertCap !== undefined) (sets.push('daily_alert_cap = ?'), vals.push(patch.dailyAlertCap));
    if (!sets.length) return;
    await this.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, now, userId);
  }

  stmtSetUserBlocked(userId: number, blocked: boolean, now: string): SqlStatement {
    return this.stmt('UPDATE users SET is_blocked = ?, updated_at = ? WHERE id = ?', blocked ? 1 : 0, now, userId);
  }

  // ---------- watches ----------

  async createWatch(userId: number, name: string, spec: WatchSpec, now: string, checkIntervalMin: number): Promise<number> {
    const cols = { ...specColumns(spec), user_id: userId, name, status: 'active', check_interval_min: checkIntervalMin, created_at: now, updated_at: now };
    const keys = Object.keys(cols);
    this.calls++;
    const r = await this.db
      .prepare(`INSERT INTO watches (${keys.join(', ')}) VALUES (${placeholders(keys.length)}) RETURNING id`)
      .bind(...(Object.values(cols) as SqlValue[]))
      .first<{ id: number }>();
    return Number(r!.id);
  }

  /** Обновить параметры watch. resetHistory — если поменялся маршрут/даты: история больше не сопоставима. */
  async updateWatchSpec(watchId: number, name: string, spec: WatchSpec, now: string, resetHistory: boolean): Promise<void> {
    const cols = { ...specColumns(spec), name, updated_at: now, error_count: 0, last_error: null };
    const sets = Object.keys(cols).map((k) => `${k} = ?`);
    const stmts = [
      this.stmt(
        `UPDATE watches SET ${sets.join(', ')}, last_checked_at = NULL${resetHistory ? ', bootstrap_baseline = NULL, bootstrap_at = NULL, last_min_price = NULL, last_min_offer = NULL' : ''} WHERE id = ?`,
        ...(Object.values(cols) as SqlValue[]),
        watchId,
      ),
    ];
    if (resetHistory) {
      stmts.push(
        this.stmt('DELETE FROM daily_min WHERE watch_id = ?', watchId),
        this.stmt('DELETE FROM observations WHERE watch_id = ?', watchId),
        this.stmt('DELETE FROM notified WHERE watch_id = ? AND muted = 0', watchId),
      );
    }
    await this.batch(stmts);
  }

  async getWatch(id: number): Promise<Watch | null> {
    const r = await this.first("SELECT * FROM watches WHERE id = ? AND status != 'deleted'", id);
    return r ? rowToWatch(r) : null;
  }

  async getWatchForUser(userId: number, id: number): Promise<Watch | null> {
    const r = await this.first("SELECT * FROM watches WHERE id = ? AND user_id = ? AND status != 'deleted'", id, userId);
    return r ? rowToWatch(r) : null;
  }

  async listWatches(userId: number): Promise<Watch[]> {
    const rows = await this.all(
      `SELECT * FROM watches WHERE user_id = ? AND status != 'deleted'
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, id`,
      userId,
    );
    return rows.map(rowToWatch);
  }

  async countActiveWatches(userId: number): Promise<number> {
    const r = await this.first<{ n: number }>("SELECT COUNT(*) AS n FROM watches WHERE user_id = ? AND status = 'active'", userId);
    return Number(r?.n ?? 0);
  }

  async setWatchStatus(id: number, status: WatchStatus, now: string): Promise<void> {
    await this.run('UPDATE watches SET status = ?, updated_at = ? WHERE id = ?', status, now, id);
  }

  stmtSetWatchStatus(id: number, status: WatchStatus, now: string): SqlStatement {
    return this.stmt('UPDATE watches SET status = ?, updated_at = ? WHERE id = ?', status, now, id);
  }

  async setManualCheckAt(id: number, now: string): Promise<void> {
    await this.run('UPDATE watches SET last_manual_check_at = ? WHERE id = ?', now, id);
  }

  /**
   * Активные watch, которым пора на проверку (с запасом 2 мин на дрожание cron), сначала самые давние.
   */
  async dueWatches(now: string, limit: number): Promise<WatchWithUser[]> {
    const rows = await this.all(
      `SELECT w.*, u.id AS u_id, u.tg_user_id AS u_tg_user_id, u.chat_id AS u_chat_id, u.username AS u_username,
              u.bound_username AS u_bound_username, u.tz AS u_tz, u.currency AS u_currency, u.quiet_from AS u_quiet_from,
              u.quiet_to AS u_quiet_to, u.daily_alert_cap AS u_daily_alert_cap, u.is_blocked AS u_is_blocked
       FROM watches w JOIN users u ON u.id = w.user_id
       WHERE w.status = 'active' AND u.is_blocked = 0
         AND (w.last_checked_at IS NULL OR (julianday(?) - julianday(w.last_checked_at)) * 1440 >= w.check_interval_min - 2)
       ORDER BY (w.last_checked_at IS NOT NULL), w.last_checked_at, w.id
       LIMIT ?`,
      now,
      limit,
    );
    return rows.map((r) => ({ watch: rowToWatch(r), user: rowToUser(prefixed(r, 'u_')) }));
  }

  async watchesForExpiry(maxDepartTo: string): Promise<WatchWithUser[]> {
    const rows = await this.all(
      `SELECT w.*, u.id AS u_id, u.tg_user_id AS u_tg_user_id, u.chat_id AS u_chat_id, u.username AS u_username,
              u.bound_username AS u_bound_username, u.tz AS u_tz, u.currency AS u_currency, u.quiet_from AS u_quiet_from,
              u.quiet_to AS u_quiet_to, u.daily_alert_cap AS u_daily_alert_cap, u.is_blocked AS u_is_blocked
       FROM watches w JOIN users u ON u.id = w.user_id
       WHERE w.status IN ('active','paused') AND w.depart_to <= ?`,
      maxDepartTo,
    );
    return rows.map((r) => ({ watch: rowToWatch(r), user: rowToUser(prefixed(r, 'u_')) }));
  }

  async countActiveAll(): Promise<number> {
    const r = await this.first<{ n: number }>("SELECT COUNT(*) AS n FROM watches WHERE status = 'active'");
    return Number(r?.n ?? 0);
  }

  stmtWatchChecked(
    id: number,
    p: { now: string; minPrice: number | null; minOffer: Offer | null; error: string | null; errorCount: number },
  ): SqlStatement {
    return this.stmt(
      `UPDATE watches SET last_checked_at = ?, last_error = ?, error_count = ?, last_min_price = ?, last_min_offer = ?
       WHERE id = ?`,
      p.now,
      p.error === null ? null : p.error.slice(0, 500),
      p.errorCount,
      p.minPrice,
      json(p.minOffer),
      id,
    );
  }

  stmtWatchBootstrap(id: number, baseline: number | null, now: string): SqlStatement {
    return this.stmt('UPDATE watches SET bootstrap_baseline = ?, bootstrap_at = ? WHERE id = ?', baseline, now, id);
  }

  // ---------- observations / daily_min ----------

  stmtsInsertObservations(watchId: number, offers: Offer[], now: string): SqlStatement[] {
    const cols = 13;
    return chunk(offers, Math.floor(100 / cols)).map((part) =>
      this.stmt(
        `INSERT INTO observations (watch_id, observed_at, origin_airport, destination_airport, depart_date, return_date,
           price, airline, flight_number, transfers, duration_min, link, source_found_at)
         VALUES ${part.map(() => `(${placeholders(cols)})`).join(',')}`,
        ...part.flatMap((o): SqlValue[] => [
          watchId,
          now,
          o.originAirport,
          o.destAirport,
          o.departAt.slice(0, 10),
          o.returnAt ? o.returnAt.slice(0, 10) : null,
          o.price,
          o.airline,
          o.flightNumber,
          Math.max(o.transfersOut, o.transfersBack ?? 0),
          o.durationMin,
          o.link,
          o.foundAt,
        ]),
      ),
    );
  }

  stmtUpsertDailyMin(watchId: number, day: string, price: number): SqlStatement {
    return this.stmt(
      `INSERT INTO daily_min (watch_id, day, min_price) VALUES (?, ?, ?)
       ON CONFLICT(watch_id, day) DO UPDATE SET min_price = MIN(min_price, excluded.min_price)`,
      watchId,
      day,
      price,
    );
  }

  stmtDailyMinHistory(watchIds: number[], sinceDay: string): SqlStatement {
    return this.stmt(
      `SELECT watch_id, day, min_price FROM daily_min WHERE watch_id IN (${placeholders(watchIds.length)}) AND day >= ? ORDER BY day`,
      ...watchIds,
      sinceDay,
    );
  }

  async dailyMinHistory(watchId: number, sinceDay: string): Promise<DailyMinPoint[]> {
    const rows = await this.all<{ day: string; min_price: number }>(
      'SELECT day, min_price FROM daily_min WHERE watch_id = ? AND day >= ? ORDER BY day',
      watchId,
      sinceDay,
    );
    return rows.map((r) => ({ day: String(r.day), minPrice: Number(r.min_price) }));
  }

  async allTimeMin(watchId: number): Promise<{ price: number; day: string } | null> {
    const r = await this.first<{ min_price: number; day: string }>(
      'SELECT min_price, day FROM daily_min WHERE watch_id = ? ORDER BY min_price, day LIMIT 1',
      watchId,
    );
    return r ? { price: Number(r.min_price), day: String(r.day) } : null;
  }

  async allTimeMins(watchIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const part of chunk(watchIds, 90)) {
      const rows = await this.all<{ watch_id: number; m: number }>(
        `SELECT watch_id, MIN(min_price) AS m FROM daily_min WHERE watch_id IN (${placeholders(part.length)}) GROUP BY watch_id`,
        ...part,
      );
      for (const r of rows) out.set(Number(r.watch_id), Number(r.m));
    }
    return out;
  }

  // ---------- notified ----------

  stmtNotified(watchIds: number[], minDepartDate: string): SqlStatement {
    return this.stmt(
      `SELECT watch_id, offer_key, last_price, muted FROM notified
       WHERE watch_id IN (${placeholders(watchIds.length)}) AND depart_date >= ?`,
      ...watchIds,
      minDepartDate,
    );
  }

  stmtUpsertNotified(watchId: number, offerKey: string, price: number, departDate: string, now: string): SqlStatement {
    return this.stmt(
      `INSERT INTO notified (watch_id, offer_key, last_price, last_sent_at, times_sent, muted, depart_date)
       VALUES (?, ?, ?, ?, 1, 0, ?)
       ON CONFLICT(watch_id, offer_key) DO UPDATE SET last_price = excluded.last_price,
         last_sent_at = excluded.last_sent_at, times_sent = notified.times_sent + 1`,
      watchId,
      offerKey,
      price,
      now,
      departDate,
    );
  }

  async muteOffer(watchId: number, offerKey: string, price: number, departDate: string, now: string): Promise<void> {
    await this.run(
      `INSERT INTO notified (watch_id, offer_key, last_price, last_sent_at, times_sent, muted, depart_date)
       VALUES (?, ?, ?, ?, 0, 1, ?)
       ON CONFLICT(watch_id, offer_key) DO UPDATE SET muted = 1`,
      watchId,
      offerKey,
      price,
      now,
      departDate,
    );
  }

  // ---------- api_cache ----------

  stmtGetCache(keys: string[], minFetchedAt: string): SqlStatement {
    return this.stmt(
      `SELECT cache_key, payload, fetched_at FROM api_cache WHERE cache_key IN (${placeholders(keys.length)}) AND fetched_at >= ?`,
      ...keys,
      minFetchedAt,
    );
  }

  async getCache(keys: string[], minFetchedAt: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!keys.length) return out;
    const stmts = chunk(keys, 90).map((part) => this.stmtGetCache(part, minFetchedAt));
    const res = await this.batch(stmts);
    for (const r of res) for (const row of r.results) out.set(String(row.cache_key), String(row.payload));
    return out;
  }

  stmtPutCache(key: string, payload: string, now: string): SqlStatement {
    return this.stmt(
      'INSERT INTO api_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at',
      key,
      payload,
      now,
    );
  }

  // ---------- wizard_state ----------

  async getWizard(tgUserId: number): Promise<{ step: string; draft: string; updatedAt: string } | null> {
    const r = await this.first<{ step: string; draft: string; updated_at: string }>(
      'SELECT step, draft, updated_at FROM wizard_state WHERE tg_user_id = ?',
      tgUserId,
    );
    return r ? { step: String(r.step), draft: String(r.draft), updatedAt: String(r.updated_at) } : null;
  }

  async setWizard(tgUserId: number, step: string, draft: string, now: string): Promise<void> {
    await this.run(
      `INSERT INTO wizard_state (tg_user_id, step, draft, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(tg_user_id) DO UPDATE SET step = excluded.step, draft = excluded.draft, updated_at = excluded.updated_at`,
      tgUserId,
      step,
      draft,
      now,
    );
  }

  async clearWizard(tgUserId: number): Promise<void> {
    await this.run('DELETE FROM wizard_state WHERE tg_user_id = ?', tgUserId);
  }

  // ---------- outbox ----------

  stmtEnqueue(p: {
    userId: number;
    watchId: number | null;
    kind: OutboxKind;
    payload: unknown;
    urgent?: boolean;
    now: string;
  }): SqlStatement {
    return this.stmt(
      `INSERT INTO outbox (user_id, watch_id, kind, payload, urgent, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
      p.userId,
      p.watchId,
      p.kind,
      JSON.stringify(p.payload),
      p.urgent ? 1 : 0,
      p.now,
    );
  }

  /** Всё, что ждёт отправки, + что уже ушло за последние 26 ч (для дневного лимита). */
  async outboxForDispatch(sinceSent: string, userId: number | null): Promise<{ pending: OutboxRow[]; recentSent: OutboxRow[]; users: Map<number, User> }> {
    const userFilter = userId !== null ? 'AND o.user_id = ?' : '';
    const userArgs: SqlValue[] = userId !== null ? [userId] : [];
    const res = await this.batch([
      this.stmt(`SELECT o.* FROM outbox o WHERE o.status = 'pending' ${userFilter} ORDER BY o.id LIMIT 200`, ...userArgs),
      this.stmt(
        `SELECT o.id, o.user_id, o.watch_id, o.kind, '' AS payload, o.urgent, o.status, o.deferred, o.attempts, o.created_at, o.sent_at
         FROM outbox o WHERE o.status = 'sent' AND o.sent_at >= ? ${userFilter}`,
        sinceSent,
        ...userArgs,
      ),
      this.stmt(
        `SELECT * FROM users WHERE id IN (SELECT DISTINCT user_id FROM outbox WHERE status = 'pending' ${userFilter.replace('o.', '')})`,
        ...userArgs,
      ),
    ]);
    const users = new Map<number, User>();
    for (const r of res[2]!.results) users.set(Number(r.id), rowToUser(r));
    return {
      pending: res[0]!.results.map(rowToOutbox),
      recentSent: res[1]!.results.map(rowToOutbox),
      users,
    };
  }

  async getOutboxItem(id: number, userId: number): Promise<OutboxRow | null> {
    const r = await this.first('SELECT * FROM outbox WHERE id = ? AND user_id = ?', id, userId);
    return r ? rowToOutbox(r) : null;
  }

  stmtOutboxSent(id: number, now: string, messageId: number | null): SqlStatement {
    return this.stmt("UPDATE outbox SET status = 'sent', sent_at = ?, tg_message_id = ?, attempts = attempts + 1 WHERE id = ?", now, messageId, id);
  }

  stmtOutboxDropped(id: number, now: string): SqlStatement {
    return this.stmt("UPDATE outbox SET status = 'dropped', sent_at = ? WHERE id = ?", now, id);
  }

  stmtOutboxDeferred(id: number, reason: 'quiet' | 'cap'): SqlStatement {
    return this.stmt('UPDATE outbox SET deferred = COALESCE(deferred, ?) WHERE id = ?', reason, id);
  }

  stmtOutboxAttempt(id: number): SqlStatement {
    return this.stmt('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?', id);
  }

  stmtInsertSent(p: { userId: number; watchId: number | null; kind: OutboxKind; payload: unknown; now: string; messageId: number | null }): SqlStatement {
    return this.stmt(
      `INSERT INTO outbox (user_id, watch_id, kind, payload, urgent, status, attempts, created_at, sent_at, tg_message_id)
       VALUES (?, ?, ?, ?, 0, 'sent', 1, ?, ?, ?)`,
      p.userId,
      p.watchId,
      p.kind,
      JSON.stringify(p.payload),
      p.now,
      p.now,
      p.messageId,
    );
  }

  /** Отметить отправленным сразу (для записей, которые уже ушли — например, ответ в чат из бота). */
  async insertSent(p: { userId: number; watchId: number | null; kind: OutboxKind; payload: unknown; now: string; messageId: number | null }): Promise<number> {
    this.calls++;
    const r = await this.db
      .prepare(
        `INSERT INTO outbox (user_id, watch_id, kind, payload, urgent, status, attempts, created_at, sent_at, tg_message_id)
         VALUES (?, ?, ?, ?, 0, 'sent', 1, ?, ?, ?) RETURNING id`,
      )
      .bind(p.userId, p.watchId, p.kind, JSON.stringify(p.payload), p.now, p.now, p.messageId)
      .first<{ id: number }>();
    return Number(r!.id);
  }

  // ---------- kv ----------

  async getKv(keys: string[]): Promise<Map<string, string>> {
    const rows = await this.all<{ key: string; value: string }>(
      `SELECT key, value FROM kv WHERE key IN (${placeholders(keys.length)})`,
      ...keys,
    );
    return new Map(rows.map((r) => [String(r.key), String(r.value)]));
  }

  stmtSetKv(key: string, value: string, now: string): SqlStatement {
    return this.stmt(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      value,
      now,
    );
  }

  async setKv(key: string, value: string, now: string): Promise<void> {
    await this.batch([this.stmtSetKv(key, value, now)]);
  }

  // ---------- counters ----------

  stmtIncr(day: string, name: string, by: number): SqlStatement {
    return this.stmt(
      'INSERT INTO counters (day, name, value) VALUES (?, ?, ?) ON CONFLICT(day, name) DO UPDATE SET value = value + excluded.value',
      day,
      name,
      by,
    );
  }

  async getCounters(day: string): Promise<Record<string, number>> {
    const rows = await this.all<{ name: string; value: number }>('SELECT name, value FROM counters WHERE day = ?', day);
    return Object.fromEntries(rows.map((r) => [String(r.name), Number(r.value)]));
  }

  // ---------- places / airlines ----------

  stmtsUpsertPlaces(places: Place[], now: string): SqlStatement[] {
    const cols = 7;
    const uniq = [...new Map(places.map((p) => [p.code, p])).values()];
    return chunk(uniq, Math.floor(100 / cols)).map((part) =>
      this.stmt(
        `INSERT INTO places (code, kind, name, city_code, city_name, country_name, updated_at)
         VALUES ${part.map(() => `(${placeholders(cols)})`).join(',')}
         ON CONFLICT(code) DO UPDATE SET kind = excluded.kind, name = excluded.name, city_code = excluded.city_code,
           city_name = excluded.city_name, country_name = excluded.country_name, updated_at = excluded.updated_at`,
        ...part.flatMap((p): SqlValue[] => [p.code, p.kind, p.name, p.cityCode, p.cityName, p.countryName, now]),
      ),
    );
  }

  stmtsReplaceAirlines(airlines: Array<{ code: string; name: string }>): SqlStatement[] {
    return [
      this.stmt('DELETE FROM airlines'),
      ...chunk(airlines, 50).map((part) =>
        this.stmt(
          `INSERT OR REPLACE INTO airlines (code, name) VALUES ${part.map(() => '(?, ?)').join(',')}`,
          ...part.flatMap((a): SqlValue[] => [a.code, a.name]),
        ),
      ),
    ];
  }

  async airlinesCount(): Promise<number> {
    const r = await this.first<{ n: number }>('SELECT COUNT(*) AS n FROM airlines');
    return Number(r?.n ?? 0);
  }

  /** Названия мест и авиакомпаний для набора кодов — одним batch. */
  async getNames(placeCodes: string[], airlineCodes: string[]): Promise<NameBook> {
    const pc = [...new Set(placeCodes)].slice(0, 95);
    const ac = [...new Set(airlineCodes.filter(Boolean))].slice(0, 95);
    const stmts: SqlStatement[] = [];
    if (pc.length) stmts.push(this.stmt(`SELECT code, kind, name, city_name FROM places WHERE code IN (${placeholders(pc.length)})`, ...pc));
    if (ac.length) stmts.push(this.stmt(`SELECT code, name FROM airlines WHERE code IN (${placeholders(ac.length)})`, ...ac));
    const res = await this.batch(stmts);
    const names: NameBook = { places: {}, airlines: {} };
    let i = 0;
    if (pc.length) {
      for (const r of res[i++]!.results) {
        names.places[String(r.code)] = {
          kind: r.kind === 'airport' ? 'airport' : 'city',
          name: String(r.name),
          cityName: str(r.city_name),
        } satisfies PlaceName;
      }
    }
    if (ac.length) for (const r of res[i]!.results) names.airlines[String(r.code)] = String(r.name);
    return names;
  }

  /** Коды аэропортов из свежих наблюдений, которых нет в справочнике. */
  async unknownAirports(sinceIso: string, limit: number): Promise<string[]> {
    const rows = await this.all<{ code: string }>(
      `SELECT DISTINCT code FROM (
         SELECT origin_airport AS code FROM observations WHERE observed_at >= ?
         UNION SELECT destination_airport FROM observations WHERE observed_at >= ?)
       WHERE code NOT IN (SELECT code FROM places) LIMIT ?`,
      sinceIso,
      sinceIso,
      limit,
    );
    return rows.map((r) => String(r.code));
  }

  // ---------- ретеншн ----------

  retentionStatements(p: {
    observationsBefore: string;
    dailyMinBefore: string;
    outboxBefore: string;
    countersBefore: string;
    cacheBefore: string;
    wizardBefore: string;
    notifiedBefore: string;
    chunk: number;
  }): SqlStatement[] {
    return [
      this.stmt('DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE observed_at < ? LIMIT ?)', p.observationsBefore, p.chunk),
      this.stmt('DELETE FROM daily_min WHERE day < ?', p.dailyMinBefore),
      this.stmt("DELETE FROM outbox WHERE status != 'pending' AND created_at < ?", p.outboxBefore),
      this.stmt('DELETE FROM counters WHERE day < ?', p.countersBefore),
      this.stmt('DELETE FROM api_cache WHERE fetched_at < ?', p.cacheBefore),
      this.stmt('DELETE FROM wizard_state WHERE updated_at < ?', p.wizardBefore),
      this.stmt('DELETE FROM notified WHERE depart_date < ?', p.notifiedBefore),
    ];
  }
}

function prefixed(r: Row, prefix: string): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}
