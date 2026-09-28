import { BUDGET, RETENTION } from '../config.ts';
import { addDays, todayIn } from '../core/dates.ts';
import { fmtPrice, routeTitle } from '../core/format.ts';
import type { SqlStatement } from '../db/sql.ts';
import { errorMessage } from '../platform/log.ts';
import { fetchAirlines, searchPlaces } from '../providers/autocomplete.ts';
import type { Services } from '../services.ts';
import { notifyAdmin } from './admin.ts';
import { dispatchOutbox } from './dispatch.ts';

export interface DailyReport {
  expired: number[];
  heartbeatSent: boolean;
}

const AIRLINES_REFRESH_DAYS = 30;

/** Cron `7 3 * * *` UTC (SPEC §9): expire, ретеншн, справочники, дайджесты, heartbeat. */
export async function runDaily(svc: Services): Promise<DailyReport> {
  const { repo, cfg, log } = svc;
  const now = svc.now();
  const nowIso = now.toISOString();
  const todayUtc = nowIso.slice(0, 10);
  const report: DailyReport = { expired: [], heartbeatSent: false };
  const writes: SqlStatement[] = [];

  // 1. Закрыть watch с прошедшим окном вылета (по дате пользователя)
  const candidates = await repo.watchesForExpiry(addDays(todayUtc, 1));
  const expiring = candidates.filter(({ watch, user }) => watch.departTo < todayIn(now, user.tz));
  if (expiring.length) {
    const mins = await repo.allTimeMins(expiring.map((e) => e.watch.id));
    const names = await repo.getNames(expiring.flatMap((e) => [...e.watch.origins, ...e.watch.destinations]), []);
    for (const { watch, user } of expiring) {
      writes.push(repo.stmtSetWatchStatus(watch.id, 'expired', nowIso));
      const min = mins.get(watch.id);
      const text =
        `🏁 Наблюдение #${watch.id} «${routeTitle(watch.origins, watch.destinations, names)}» завершено — окно вылета прошло.\n` +
        (min !== undefined
          ? `Минимальная цена за всё время наблюдения: <b>${fmtPrice(min, user.currency)}</b>.`
          : 'Подходящих билетов за время наблюдения так и не нашлось.') +
        '\nСоздать новое — /new';
      writes.push(repo.stmtEnqueue({ userId: user.id, watchId: watch.id, kind: 'system', payload: { text }, now: nowIso }));
      report.expired.push(watch.id);
    }
  }

  // 2. Ретеншн
  writes.push(
    ...repo.retentionStatements({
      observationsBefore: new Date(now.getTime() - RETENTION.OBSERVATIONS_DAYS * 86_400_000).toISOString(),
      dailyMinBefore: addDays(todayUtc, -RETENTION.DAILY_MIN_DAYS),
      outboxBefore: new Date(now.getTime() - RETENTION.OUTBOX_DAYS * 86_400_000).toISOString(),
      countersBefore: addDays(todayUtc, -RETENTION.COUNTERS_DAYS),
      cacheBefore: new Date(now.getTime() - RETENTION.API_CACHE_HOURS * 3_600_000).toISOString(),
      wizardBefore: new Date(now.getTime() - 86_400_000).toISOString(),
      notifiedBefore: addDays(todayUtc, -2),
      chunk: RETENTION.DELETE_CHUNK,
    }),
  );
  await repo.batch(writes);

  // 3. Справочники: авиакомпании раз в месяц, неизвестные аэропорты — понемногу
  try {
    const kv = await repo.getKv(['airlines_at']);
    const at = kv.get('airlines_at');
    if (!at || now.getTime() - Date.parse(at) > AIRLINES_REFRESH_DAYS * 86_400_000) {
      const airlines = await fetchAirlines({ fetch: svc.fetch });
      if (airlines.length > 100) {
        await repo.batch([...repo.stmtsReplaceAirlines(airlines), repo.stmtSetKv('airlines_at', nowIso, nowIso)]);
      }
    }
    const unknown = await repo.unknownAirports(new Date(now.getTime() - 7 * 86_400_000).toISOString(), 5);
    const found = [];
    for (const code of unknown) {
      const places = await searchPlaces(code, { fetch: svc.fetch }).catch(() => []);
      found.push(...places.filter((p) => p.code === code || p.cityCode === code));
    }
    if (found.length) await repo.batch(repo.stmtsUpsertPlaces(found, nowIso));
  } catch (e) {
    log.warn('reference data refresh failed', { error: errorMessage(e) });
  }

  // 4. Отложенные дайджесты и сообщения об истечении
  await dispatchOutbox(
    { repo, messenger: svc.messenger, budget: svc.budget, log, now, marker: cfg.marker },
    { maxMessages: BUDGET.TICK_TG_MESSAGES, reserveSubrequests: 4 },
  );

  // 5. Heartbeat админу за прошедшие сутки (UTC)
  const yesterday = addDays(todayUtc, -1);
  const [c, active, kv] = await Promise.all([
    repo.getCounters(yesterday),
    repo.countActiveAll(),
    repo.getKv(['rate_limited_until', 'last_tick_at']),
  ]);
  const errors = (c.api_errors ?? 0) + (c.tg_errors ?? 0);
  const lines = [
    `💓 Жив. Сводка за ${yesterday} (UTC):`,
    `активных watch: ${active}`,
    `запросов к API: ${c.api_requests ?? 0}, ошибок: ${errors} (API ${c.api_errors ?? 0}, Telegram ${c.tg_errors ?? 0})`,
    `проверок: ${c.checks ?? 0}, тиков: ${c.ticks ?? 0}, уведомлений отправлено: ${c.tg_sent ?? 0}`,
  ];
  if ((c.rate_limited ?? 0) > 0) lines.push(`429 от Travelpayouts: ${c.rate_limited} раз`);
  if ((c.tick_aborted ?? 0) > 0) {
    lines.push(`⚠️ тиков, оборванных платформой (вероятно, лимит CPU): ${c.tick_aborted}. Если повторяется — см. README, раздел «Эксплуатация».`);
  }
  const rl = kv.get('rate_limited_until');
  if (rl && Date.parse(rl) > now.getTime()) lines.push(`⚠️ пауза запросов до ${rl}`);
  if (report.expired.length) lines.push(`завершено по сроку: ${report.expired.map((id) => `#${id}`).join(', ')}`);
  report.heartbeatSent = await notifyAdmin(svc, 'heartbeat', lines.join('\n'), 20 * 60);

  log.info('daily done', { expired: report.expired.length, subrequests: svc.budget.used });
  return report;
}
