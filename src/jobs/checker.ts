import { BOT, NOTIFY, PROVIDER, RETENTION } from '../config.ts';
import { addDays, hoursBetween, todayIn } from '../core/dates.ts';
import { offerKey, selectMatching } from '../core/filters.ts';
import type { AlertOffer, AlertPayload } from '../core/format.ts';
import { isUrgent, shouldNotify, type NotifiedState } from '../core/notifyPolicy.ts';
import {
  autoTarget,
  computeStats,
  evaluatePrice,
  fetchTarget,
  median,
  type DailyMinPoint,
  type PriceStats,
} from '../core/priceDetector.ts';
import { calendarKey, planBootstrap, planQueries, queryKey } from '../core/queryPlanner.ts';
import type { FareQuery, Offer, User, Watch } from '../core/types.ts';
import type { Repo } from '../db/repo.ts';
import type { SqlStatement } from '../db/sql.ts';
import type { Budget } from '../platform/budget.ts';
import { errorMessage, type Logger } from '../platform/log.ts';
import { ProviderError, type FareProvider } from '../providers/FareProvider.ts';

export type CheckMode = 'tick' | 'initial' | 'manual';

export interface CheckTarget {
  watch: Watch;
  user: User;
  mode: CheckMode;
}

export interface CheckDeps {
  repo: Repo;
  provider: FareProvider;
  budget: Budget;
  log: Logger;
  now: Date;
  market: string;
}

export interface CheckOptions {
  /** Максимум запросов к API (включая догрузку страниц и бутстрап). */
  apiBudget: number;
  /** Сколько «сырого» JSON можно разобрать (защита от лимита CPU). */
  maxResponseBytes: number;
  /** Сколько subrequests оставить на запись в D1 и отправку сообщений. */
  reserveSubrequests: number;
  /** Не начинать новые запросы после этого момента (epoch ms). */
  deadline?: number;
}

export interface CheckReport {
  /** Проверенные watch (last_checked_at обновлён). */
  checked: number[];
  /** Не уместились в бюджет — пойдут следующим тиком. */
  deferred: number[];
  apiRequests: number;
  apiErrors: number;
  alerts: number;
  abort: null | 'auth' | 'rate_limit';
  retryAfterSec: number | null;
}

interface QueryState {
  key: string;
  query: FareQuery;
  offers: Offer[];
  pages: number;
  lastRawCount: number;
  lastPrice: number;
  done: boolean;
  fromCache: boolean;
  error: ProviderError | null;
  /** Не выполнен из-за бюджета/прерывания — watch уйдёт в следующий тик. */
  skipped: boolean;
  watchers: Planned[];
}

interface Planned {
  target: CheckTarget;
  keys: string[];
  stats: PriceStats;
  history: DailyMinPoint[];
  notified: Map<string, NotifiedState>;
  bootstrapBaseline: number | null;
}

interface CachePayload {
  v: 1;
  offers: Offer[];
  pages: number;
  done: boolean;
}

/** Страница последняя, если записей заметно меньше limit (API слегка недодаёт и на полных). */
export function isLastPage(rawCount: number): boolean {
  return rawCount < PROVIDER.PAGE_LIMIT * PROVIDER.PAGE_FULL_RATIO;
}

/** Оценка объёма первой страницы ответа по типу запроса (по замерам на реальном API). */
export function estimateResponseBytes(q: FareQuery): number {
  if (q.oneWay) return 25_000; // один билет на дату: ≤ 31 запись
  const monthly = q.departureAt.length === 7 && (q.returnAt?.length ?? 0) === 7;
  return monthly ? 150_000 : 50_000;
}

/** Кэш ответа провайдера: самые дешёвые CACHE_MAX_OFFERS офферов (нормализованные). */
export function encodeCache(offers: Offer[], pages: number, done: boolean): string {
  const top = [...offers].sort((a, b) => a.price - b.price).slice(0, PROVIDER.CACHE_MAX_OFFERS);
  return JSON.stringify({ v: 1, offers: top, pages, done } satisfies CachePayload);
}

export function decodeCache(raw: string | undefined): CachePayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as CachePayload;
    return p.v === 1 && Array.isArray(p.offers) ? p : null;
  } catch {
    return null;
  }
}

/** Параллельный map с ограничением числа одновременных задач. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Проверка набора watch: план → кэш → запросы (в рамках бюджета) → бутстрап → фильтры → детектор →
 * запись observations/daily_min/notified → постановка уведомлений в outbox.
 * Всё идемпотентно: повтор с теми же ценами не создаёт новых уведомлений (dedup по notified).
 */
export async function runChecks(deps: CheckDeps, targets: CheckTarget[], opts: CheckOptions): Promise<CheckReport> {
  const { repo, provider, budget, log, now } = deps;
  const nowIso = now.toISOString();
  const todayUtc = nowIso.slice(0, 10);
  const report: CheckReport = {
    checked: [],
    deferred: [],
    apiRequests: 0,
    apiErrors: 0,
    alerts: 0,
    abort: null,
    retryAfterSec: null,
  };
  const writes: SqlStatement[] = [];

  // ---------- 1. План ----------
  const planned: Planned[] = [];
  const states = new Map<string, QueryState>();
  for (const t of targets) {
    const today = todayIn(now, t.user.tz);
    const plan = planQueries(t.watch, today, { currency: t.user.currency, market: deps.market });
    if (!plan.ok) {
      const passed = plan.error.code === 'window_passed';
      writes.push(
        repo.stmtWatchChecked(t.watch.id, {
          now: nowIso,
          minPrice: t.watch.lastMinPrice,
          minOffer: t.watch.lastMinOffer,
          error: passed ? null : plan.error.message,
          errorCount: passed ? 0 : t.watch.errorCount,
        }),
      );
      if (t.mode !== 'tick') {
        writes.push(repo.stmtEnqueue({ userId: t.user.id, watchId: t.watch.id, kind: 'reply', payload: { text: `⚠️ #${t.watch.id}: ${plan.error.message}` }, now: nowIso }));
      }
      report.checked.push(t.watch.id);
      continue;
    }
    const p: Planned = {
      target: t,
      keys: [],
      stats: computeStats([], todayUtc, t.watch.bootstrapBaseline),
      history: [],
      notified: new Map(),
      bootstrapBaseline: t.watch.bootstrapBaseline,
    };
    for (const q of plan.value) {
      const key = queryKey(q);
      p.keys.push(key);
      let st = states.get(key);
      if (!st) {
        st = { key, query: q, offers: [], pages: 0, lastRawCount: 0, lastPrice: 0, done: false, fromCache: false, error: null, skipped: false, watchers: [] };
        states.set(key, st);
      }
      st.watchers.push(p);
    }
    planned.push(p);
  }

  // ---------- 2. Контекст и кэш одним batch ----------
  let cachedBytes = 0;
  if (planned.length) {
    const watchIds = planned.map((p) => p.target.watch.id);
    const keys = [...states.keys()];
    const minFetched = new Date(now.getTime() - PROVIDER.CACHE_TTL_MIN * 60_000).toISOString();
    const stmts: SqlStatement[] = [
      repo.stmtDailyMinHistory(watchIds, addDays(todayUtc, -RETENTION.DAILY_MIN_DAYS)),
      repo.stmtNotified(watchIds, addDays(todayUtc, -1)),
    ];
    for (let i = 0; i < keys.length; i += 90) stmts.push(repo.stmtGetCache(keys.slice(i, i + 90), minFetched));
    const res = await repo.batch(stmts);
    const byId = new Map(planned.map((p) => [p.target.watch.id, p]));
    for (const r of res[0]!.results) {
      byId.get(Number(r.watch_id))?.history.push({ day: String(r.day), minPrice: Number(r.min_price) });
    }
    for (const r of res[1]!.results) {
      byId.get(Number(r.watch_id))?.notified.set(String(r.offer_key), { lastPrice: Number(r.last_price), muted: Number(r.muted) === 1 });
    }
    for (const r of res.slice(2).flatMap((x) => x.results)) {
      const st = states.get(String(r.cache_key));
      const raw = String(r.payload);
      cachedBytes += raw.length;
      const payload = decodeCache(raw);
      // битый кэш — просто перезапросим
      if (st && payload) Object.assign(st, { offers: payload.offers, pages: payload.pages, done: payload.done, fromCache: true });
    }
    for (const p of planned) p.stats = computeStats(p.history, todayUtc, p.bootstrapBaseline);
  }

  // ---------- 3. Отбор watch под бюджет (кэшированные запросы бесплатны) ----------
  // Первый watch берётся всегда (иначе широкий watch мог бы откладываться бесконечно),
  // остальные — пока хватает бюджета запросов и оценочного объёма JSON (CPU).
  let apiUsed = 0;
  let estimatedBytes = cachedBytes;
  const selectedKeys = new Set<string>();
  const accepted: Planned[] = [];
  for (const p of planned) {
    const fresh = p.keys.filter((k) => !states.get(k)!.fromCache && !selectedKeys.has(k));
    const bytes = fresh.reduce((sum, k) => sum + estimateResponseBytes(states.get(k)!.query), 0);
    const fits = selectedKeys.size + fresh.length <= opts.apiBudget && estimatedBytes + bytes <= opts.maxResponseBytes;
    if (!fits && accepted.length > 0) {
      report.deferred.push(p.target.watch.id);
      continue;
    }
    if (selectedKeys.size + fresh.length > opts.apiBudget) {
      report.deferred.push(p.target.watch.id);
      continue;
    }
    fresh.forEach((k) => selectedKeys.add(k));
    estimatedBytes += bytes;
    accepted.push(p);
  }
  for (const [key, st] of states) {
    if (!st.fromCache && !selectedKeys.has(key)) st.skipped = true;
  }

  const canSpend = () =>
    report.abort === null &&
    apiUsed < opts.apiBudget &&
    budget.remaining() > opts.reserveSubrequests &&
    (opts.deadline === undefined || Date.now() < opts.deadline);
  /** Догрузка страниц сверх первой — только пока не превышен объём JSON. */
  const canSpendExtra = () => canSpend() && budget.responseBytes < opts.maxResponseBytes;

  const handleError = (e: unknown): ProviderError => {
    const pe = e instanceof ProviderError ? e : new ProviderError('bad_response', errorMessage(e));
    if (pe.kind === 'auth') report.abort = 'auth';
    if (pe.kind === 'rate_limit') {
      report.abort = report.abort ?? 'rate_limit';
      report.retryAfterSec = pe.retryAfterSec;
    }
    return pe;
  };

  /** Бюджет кончился или API попросил остановиться: первая страница — watch уходит в следующий тик, дальше — берём что есть. */
  const stopQuery = (st: QueryState, page: number) => {
    if (page === 1) st.skipped = true;
    else st.done = true;
  };

  async function fetchPage(st: QueryState, page: number): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(page === 1 ? canSpend() : canSpendExtra())) return stopQuery(st, page);
      apiUsed++;
      report.apiRequests++;
      try {
        const res = await provider.search(st.query, page, PROVIDER.PAGE_LIMIT);
        budget.responseBytes += res.bytes;
        st.offers.push(...res.offers);
        st.pages = page;
        st.lastRawCount = res.rawCount;
        st.lastPrice = res.offers.length ? Math.max(...res.offers.map((o) => o.price)) : 0;
        st.done = isLastPage(res.rawCount);
        return;
      } catch (e) {
        const pe = handleError(e);
        report.apiErrors++;
        log.warn('provider error', { key: st.key, page, kind: pe.kind, status: pe.status, error: pe.message });
        // 401/429 — проблема не этого watch: не считаем ошибкой, просто откладываем
        if (pe.kind === 'auth' || pe.kind === 'rate_limit') return stopQuery(st, page);
        if (pe.retryable && attempt === 0) continue;
        if (page === 1) st.error = pe;
        else st.done = true;
        return;
      }
    }
  }

  // ---------- 4. Запросы: волна страниц 1, затем догрузка ----------
  let wave = [...selectedKeys].map((k) => states.get(k)!);
  for (let page = 1; page <= PROVIDER.MAX_PAGES && wave.length; page++) {
    await mapLimit(wave, PROVIDER.CONCURRENCY, (st) => fetchPage(st, page));
    wave = wave.filter((st) => {
      if (st.error || st.skipped || st.done || page >= PROVIDER.MAX_PAGES) return false;
      const targetsMet = st.watchers.some((w) => {
        const t = fetchTarget(w.target.watch, w.stats);
        return t !== null && st.lastPrice <= t;
      });
      const noMatchYet = st.watchers.some((w) => selectMatching(st.offers, w.target.watch, now).length === 0);
      if (targetsMet || noMatchYet) return true;
      st.done = true;
      return false;
    });
  }

  // кэш свежих ответов
  for (const k of selectedKeys) {
    const st = states.get(k)!;
    if (st.error || st.skipped || st.pages === 0) continue;
    writes.push(repo.stmtPutCache(k, encodeCache(st.offers, st.pages, st.done), nowIso));
  }

  // ---------- 5. Бутстрап истории для авто-режима (холодный старт) ----------
  for (const p of accepted) {
    const w = p.target.watch;
    if (w.priceMode === 'threshold' || p.stats.confidence === 'high') continue;
    const due = w.bootstrapAt === null || (w.bootstrapBaseline === null && hoursBetween(w.bootstrapAt, now) >= 24);
    if (!due || !canSpend()) continue;
    const queries = planBootstrap(w, todayIn(now, p.target.user.tz), {
      currency: p.target.user.currency,
      market: deps.market,
      neighborMonths: PROVIDER.BOOTSTRAP_NEIGHBOR_MONTHS,
      maxQueries: PROVIDER.BOOTSTRAP_MAX_QUERIES,
    });
    const minByDate = new Map<string, number>();
    const seen = new Set<string>();
    let failed = false;
    await mapLimit(queries, PROVIDER.CONCURRENCY, async (q) => {
      const k = calendarKey(q);
      if (seen.has(k) || !canSpend()) return;
      seen.add(k);
      apiUsed++;
      report.apiRequests++;
      try {
        for (const pt of await provider.calendar(q)) {
          minByDate.set(pt.departDate, Math.min(minByDate.get(pt.departDate) ?? Infinity, pt.price));
        }
      } catch (e) {
        handleError(e);
        report.apiErrors++;
        failed = true;
      }
    });
    if (failed && minByDate.size === 0) continue; // попробуем в следующий раз
    const values = [...minByDate.values()];
    const baseline = values.length >= PROVIDER.BOOTSTRAP_MIN_POINTS ? median(values) : null;
    p.bootstrapBaseline = baseline;
    p.stats = computeStats(p.history, todayUtc, baseline);
    writes.push(repo.stmtWatchBootstrap(w.id, baseline, nowIso));
  }

  // ---------- 6. Оценка и запись ----------
  for (const p of accepted) {
    const { watch, user, mode } = p.target;
    const sts = p.keys.map((k) => states.get(k)!);
    if (sts.some((s) => s.skipped)) {
      report.deferred.push(watch.id);
      continue;
    }
    const failed = sts.filter((s) => s.error);
    const offers = sts.filter((s) => !s.error).flatMap((s) => s.offers);

    if (failed.length === sts.length) {
      const errorCount = watch.errorCount + 1;
      const message = failed[0]!.error!.message;
      writes.push(repo.stmtWatchChecked(watch.id, { now: nowIso, minPrice: watch.lastMinPrice, minOffer: watch.lastMinOffer, error: message, errorCount }));
      if (errorCount === NOTIFY.WATCH_ERRORS_BEFORE_NOTICE) {
        writes.push(
          repo.stmtEnqueue({
            userId: user.id,
            watchId: watch.id,
            kind: 'system',
            payload: { text: `⚠️ Наблюдение #${watch.id}: ${errorCount} ошибок источника цен подряд. Продолжаю пытаться; если не пройдёт — напишу админу.` },
            now: nowIso,
          }),
        );
      }
      if (mode !== 'tick') {
        writes.push(repo.stmtEnqueue({ userId: user.id, watchId: watch.id, kind: 'reply', payload: { text: `⚠️ Проверка #${watch.id} не удалась: источник цен временно недоступен. Попробую позже.` }, now: nowIso }));
      }
      report.checked.push(watch.id);
      continue;
    }

    const matching = selectMatching(offers, watch, now);
    const evaluated: AlertOffer[] = matching.map((o) => ({ offer: o, reasons: evaluatePrice(o.price, watch, p.stats) }));
    const alerts = evaluated.filter((a) => a.reasons.length > 0 && shouldNotify(p.notified.get(offerKey(a.offer)), a.offer.price, user.currency));
    const best = matching[0] ?? null;

    if (failed.length === 0) {
      writes.push(...repo.stmtsInsertObservations(watch.id, matching.slice(0, RETENTION.OBSERVATIONS_PER_CHECK), nowIso));
      if (best) writes.push(repo.stmtUpsertDailyMin(watch.id, todayUtc, best.price));
    }
    writes.push(
      repo.stmtWatchChecked(watch.id, {
        now: nowIso,
        minPrice: best?.price ?? null,
        minOffer: best,
        error: failed.length ? failed[0]!.error!.message : null,
        errorCount: failed.length ? watch.errorCount + 1 : 0,
      }),
    );
    for (const a of alerts) {
      writes.push(repo.stmtUpsertNotified(watch.id, offerKey(a.offer), a.offer.price, a.offer.departAt.slice(0, 10), nowIso));
    }

    const base = {
      v: 1 as const,
      watchId: watch.id,
      origins: watch.origins,
      destinations: watch.destinations,
      tripType: watch.tripType,
      adults: watch.adults,
      currency: user.currency,
      priceMode: watch.priceMode,
      maxPrice: watch.maxPrice,
      checkedAt: nowIso,
    };
    if (mode === 'tick') {
      if (alerts.length) {
        const payload: AlertPayload = { ...base, mode: 'alert', offers: alerts.slice(0, NOTIFY.SHOW_ALL_N), total: alerts.length };
        const urgent = watch.priceMode !== 'auto' && alerts.some((a) => isUrgent(a.offer.price, watch.maxPrice));
        writes.push(repo.stmtEnqueue({ userId: user.id, watchId: watch.id, kind: 'alert', payload, urgent, now: nowIso }));
        report.alerts++;
      }
    } else {
      const shown = alerts.length ? alerts.slice(0, NOTIFY.SHOW_ALL_N) : evaluated.slice(0, NOTIFY.TOP_N);
      const payload: AlertPayload = {
        ...base,
        mode,
        offers: shown,
        total: alerts.length || shown.length,
        baseline: p.stats.baseline,
        confidence: p.stats.confidence,
        autoTarget: autoTarget(watch, p.stats),
      };
      writes.push(repo.stmtEnqueue({ userId: user.id, watchId: watch.id, kind: 'reply', payload, now: nowIso }));
      if (alerts.length) report.alerts++;
    }
    report.checked.push(watch.id);
  }

  // watch, которые не попали в accepted, но были в плане, уже в report.deferred
  const dayCounters: Array<[string, number]> = [
    ['api_requests', report.apiRequests],
    ['api_errors', report.apiErrors],
    ['checks', report.checked.length],
    ['alerts', report.alerts],
  ];
  for (const [name, by] of dayCounters) if (by > 0) writes.push(repo.stmtIncr(todayUtc, name, by));

  if (writes.length) await repo.batch(writes);
  return report;
}

/** Цель проверки, построенная для ручной проверки/создания (кулдаун проверяет вызывающий). */
export function manualTarget(watch: Watch, user: User, mode: 'initial' | 'manual'): CheckTarget {
  return { watch, user, mode };
}

export function manualCooldownLeftMin(watch: Watch, now: Date): number {
  if (!watch.lastManualCheckAt) return 0;
  const passed = (now.getTime() - Date.parse(watch.lastManualCheckAt)) / 60_000;
  return Math.max(0, Math.ceil(BOT.MANUAL_CHECK_COOLDOWN_MIN - passed));
}
