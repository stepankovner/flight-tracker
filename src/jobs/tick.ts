import { BUDGET, PROVIDER } from '../config.ts';
import type { SqlStatement } from '../db/sql.ts';
import type { Services } from '../services.ts';
import { notifyAdmin } from './admin.ts';
import { runChecks, type CheckReport } from './checker.ts';
import { dispatchOutbox, type DispatchReport } from './dispatch.ts';

export interface TickReport {
  skippedRateLimit: boolean;
  /** Предыдущий тик не дошёл до конца (например, оборван по CPU) — его watch отодвинуты в конец очереди. */
  recoveredAbort: number[];
  budgetFactor: number;
  checks: CheckReport | null;
  dispatch: DispatchReport;
}

/** Длительность паузы после 429: экспонента от уровня, не меньше retry-after из заголовков. */
export function backoffMinutes(level: number, retryAfterSec: number | null): number {
  const exp = Math.min(PROVIDER.BACKOFF_START_MIN * 2 ** Math.max(0, level - 1), PROVIDER.BACKOFF_MAX_MIN);
  const hinted = retryAfterSec ? Math.ceil(retryAfterSec / 60) : 0;
  return Math.max(exp, hinted);
}

interface Inflight {
  at: string;
  ids: number[];
}

function parseInflight(raw: string | undefined): Inflight | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Inflight;
    return Array.isArray(v.ids) && typeof v.at === 'string' ? v : null;
  } catch {
    return null;
  }
}

// Cron "*/5 * * * *": проверки due-watch + рассылка очереди (SPEC §9; частота — см. docs/DECISIONS.md).
export async function runTick(svc: Services): Promise<TickReport> {
  const { repo, cfg, log } = svc;
  const now = svc.now();
  const nowIso = now.toISOString();
  const day = nowIso.slice(0, 10);
  const kv = await repo.getKv(['rate_limited_until', 'rate_limit_level', 'tick_inflight', 'tick_budget_factor']);
  const rlUntil = kv.get('rate_limited_until');
  const level = Number(kv.get('rate_limit_level') ?? 0);
  let factor = Number(kv.get('tick_budget_factor') ?? 1) || 1;
  const report: TickReport = {
    skippedRateLimit: false,
    recoveredAbort: [],
    budgetFactor: factor,
    checks: null,
    dispatch: { sent: 0, deferred: 0, dropped: 0, failed: 0, floodWaitSec: null },
  };
  const writes: SqlStatement[] = [repo.stmtSetKv('last_tick_at', nowIso, nowIso), repo.stmtIncr(day, 'ticks', 1)];

  // Маркер «в работе» остался от прошлого тика — значит, тот не дошёл до конца (скорее всего, лимит CPU).
  // Его watch уходят в конец очереди с ошибкой (чтобы один тяжёлый watch не блокировал остальных),
  // а объём работы за тик временно уменьшается.
  const inflight = parseInflight(kv.get('tick_inflight'));
  if (inflight && now.getTime() - Date.parse(inflight.at) > 60_000) {
    report.recoveredAbort = inflight.ids;
    factor = Math.max(BUDGET.ABORT_BUDGET_FACTOR_MIN, factor / 2);
    const recover: SqlStatement[] = [repo.stmtSetKv('tick_inflight', '', nowIso), repo.stmtSetKv('tick_budget_factor', String(factor), nowIso), repo.stmtIncr(day, 'tick_aborted', 1)];
    for (const id of inflight.ids) recover.push(repo.stmtWatchAborted(id, nowIso));
    await repo.batch(recover);
    log.warn('previous tick did not finish', { watches: inflight.ids, factor });
    await notifyAdmin(
      svc,
      'tick_aborted',
      `Предыдущий тик (${inflight.at}) не завершился — вероятно, превышен лимит CPU Workers. ` +
        `Наблюдения ${inflight.ids.map((id) => `#${id}`).join(', ')} отложены, объём работы за тик уменьшен до ${Math.round(factor * 100)}%.`,
    );
  }
  report.budgetFactor = factor;

  if (rlUntil && Date.parse(rlUntil) > now.getTime()) {
    report.skippedRateLimit = true;
  } else {
    const due = await repo.dueWatches(nowIso, 60);
    if (due.length) {
      let marked = false;
      report.checks = await runChecks(
        { repo, provider: svc.provider, budget: svc.budget, log, now, market: cfg.market },
        due.map((d) => ({ ...d, mode: 'tick' as const })),
        {
          apiBudget: BUDGET.TICK_API_REQUESTS,
          maxResponseBytes: Math.round(BUDGET.TICK_MAX_RESPONSE_BYTES * factor),
          reserveSubrequests: BUDGET.TICK_TG_MESSAGES + BUDGET.RESERVE_FOR_WRITES + 2,
          onSelected: async (ids) => {
            marked = true;
            await repo.setKv('tick_inflight', JSON.stringify({ at: nowIso, ids } satisfies Inflight), nowIso);
          },
        },
      );
      if (marked) writes.push(repo.stmtSetKv('tick_inflight', '', nowIso));
      const c = report.checks;
      if (c.abort === 'auth') {
        await notifyAdmin(svc, 'tp_auth', 'Travelpayouts ответил 401/403: неверный или отозванный TRAVELPAYOUTS_TOKEN. Проверки остановлены до исправления (обнови токен в .dev.vars и выполни npm run secrets:push).');
      } else if (c.abort === 'rate_limit') {
        const next = level + 1;
        const minutes = backoffMinutes(next, c.retryAfterSec);
        writes.push(
          repo.stmtSetKv('rate_limited_until', new Date(now.getTime() + minutes * 60_000).toISOString(), nowIso),
          repo.stmtSetKv('rate_limit_level', String(next), nowIso),
          repo.stmtIncr(day, 'rate_limited', 1),
        );
        log.warn('rate limited by provider', { minutes, level: next });
        if (next >= 4) await notifyAdmin(svc, 'tp_rate_limit', `Travelpayouts отвечает 429 уже ${next} раз подряд; пауза ${minutes} мин.`);
      } else if (level > 0 && c.apiRequests > c.apiErrors) {
        writes.push(repo.stmtSetKv('rate_limit_level', '0', nowIso));
      }
    }
  }

  // тик дошёл до конца — постепенно возвращаем полный объём работы
  if (factor < 1 && report.recoveredAbort.length === 0) {
    writes.push(repo.stmtSetKv('tick_budget_factor', String(Math.min(1, factor * BUDGET.ABORT_BUDGET_RECOVERY)), nowIso));
  }

  report.dispatch = await dispatchOutbox(
    { repo, messenger: svc.messenger, budget: svc.budget, log, now, marker: cfg.marker },
    { maxMessages: BUDGET.TICK_TG_MESSAGES, reserveSubrequests: 1 },
  );
  await repo.batch(writes);
  log.info('tick done', {
    checked: report.checks?.checked.length ?? 0,
    deferred: report.checks?.deferred.length ?? 0,
    api: report.checks?.apiRequests ?? 0,
    alerts: report.checks?.alerts ?? 0,
    sent: report.dispatch.sent,
    factor,
    subrequests: svc.budget.used,
  });
  return report;
}
