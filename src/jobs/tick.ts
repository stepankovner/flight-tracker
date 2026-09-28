import { BUDGET, PROVIDER } from '../config.ts';
import type { Services } from '../services.ts';
import { notifyAdmin } from './admin.ts';
import { runChecks, type CheckReport } from './checker.ts';
import { dispatchOutbox, type DispatchReport } from './dispatch.ts';

export interface TickReport {
  skippedRateLimit: boolean;
  checks: CheckReport | null;
  dispatch: DispatchReport;
}

/** Длительность паузы после 429: экспонента от уровня, не меньше retry-after из заголовков. */
export function backoffMinutes(level: number, retryAfterSec: number | null): number {
  const exp = Math.min(PROVIDER.BACKOFF_START_MIN * 2 ** Math.max(0, level - 1), PROVIDER.BACKOFF_MAX_MIN);
  const hinted = retryAfterSec ? Math.ceil(retryAfterSec / 60) : 0;
  return Math.max(exp, hinted);
}

// Cron "*/15 * * * *" (SPEC §9).
export async function runTick(svc: Services): Promise<TickReport> {
  const { repo, cfg } = svc;
  const now = svc.now();
  const nowIso = now.toISOString();
  const kv = await repo.getKv(['rate_limited_until', 'rate_limit_level']);
  const rlUntil = kv.get('rate_limited_until');
  const level = Number(kv.get('rate_limit_level') ?? 0);
  const report: TickReport = { skippedRateLimit: false, checks: null, dispatch: { sent: 0, deferred: 0, dropped: 0, failed: 0, floodWaitSec: null } };
  const kvWrites = [repo.stmtSetKv('last_tick_at', nowIso, nowIso), repo.stmtIncr(nowIso.slice(0, 10), 'ticks', 1)];

  if (rlUntil && Date.parse(rlUntil) > now.getTime()) {
    report.skippedRateLimit = true;
  } else {
    const due = await repo.dueWatches(nowIso, 60);
    if (due.length) {
      report.checks = await runChecks(
        { repo, provider: svc.provider, budget: svc.budget, log: svc.log, now, market: cfg.market },
        due.map((d) => ({ ...d, mode: 'tick' as const })),
        {
          apiBudget: BUDGET.TICK_API_REQUESTS,
          maxResponseBytes: BUDGET.TICK_MAX_RESPONSE_BYTES,
          reserveSubrequests: BUDGET.TICK_TG_MESSAGES + BUDGET.RESERVE_FOR_WRITES + 2,
        },
      );
      const c = report.checks;
      if (c.abort === 'auth') {
        await notifyAdmin(svc, 'tp_auth', 'Travelpayouts ответил 401/403: неверный или отозванный TRAVELPAYOUTS_TOKEN. Проверки остановлены до исправления (wrangler secret put TRAVELPAYOUTS_TOKEN).');
      } else if (c.abort === 'rate_limit') {
        const next = level + 1;
        const minutes = backoffMinutes(next, c.retryAfterSec);
        kvWrites.push(
          repo.stmtSetKv('rate_limited_until', new Date(now.getTime() + minutes * 60_000).toISOString(), nowIso),
          repo.stmtSetKv('rate_limit_level', String(next), nowIso),
          repo.stmtIncr(nowIso.slice(0, 10), 'rate_limited', 1),
        );
        svc.log.warn('rate limited by provider', { minutes, level: next });
        if (next >= 4) await notifyAdmin(svc, 'tp_rate_limit', `Travelpayouts отвечает 429 уже ${next} раз подряд; пауза ${minutes} мин.`);
      } else if (level > 0 && c.apiRequests > c.apiErrors) {
        kvWrites.push(repo.stmtSetKv('rate_limit_level', '0', nowIso));
      }
    }
  }

  report.dispatch = await dispatchOutbox(
    { repo, messenger: svc.messenger, budget: svc.budget, log: svc.log, now, marker: cfg.marker },
    { maxMessages: BUDGET.TICK_TG_MESSAGES, reserveSubrequests: 1 },
  );
  await repo.batch(kvWrites);
  svc.log.info('tick done', {
    checked: report.checks?.checked.length ?? 0,
    deferred: report.checks?.deferred.length ?? 0,
    api: report.checks?.apiRequests ?? 0,
    alerts: report.checks?.alerts ?? 0,
    sent: report.dispatch.sent,
    subrequests: svc.budget.used,
  });
  return report;
}
