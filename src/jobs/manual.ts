import { BUDGET } from '../config.ts';
import type { User } from '../core/types.ts';
import type { Services } from '../services.ts';
import { notifyAdmin } from './admin.ts';
import { runChecks } from './checker.ts';
import { dispatchOutbox } from './dispatch.ts';

/**
 * Проверка сразу после создания (точка отсчёта) или по кнопке/команде «проверить сейчас».
 * Выполняется в ctx.waitUntil после ответа Telegram (≤ 30 с), поэтому с дедлайном.
 */
export async function runInitialCheck(svc: Services, watchId: number, user: User, mode: 'initial' | 'manual'): Promise<void> {
  const { repo } = svc;
  const now = svc.now();
  const watch = await repo.getWatchForUser(user.id, watchId);
  if (!watch) return;

  const kv = await repo.getKv(['rate_limited_until']);
  const rl = kv.get('rate_limited_until');
  if (rl && Date.parse(rl) > now.getTime()) {
    await repo.batch([
      repo.stmtEnqueue({ userId: user.id, watchId, kind: 'reply', payload: { text: `⏳ Источник цен попросил сделать паузу. Наблюдение #${watchId} проверю автоматически чуть позже.` }, now: now.toISOString() }),
    ]);
  } else {
    const report = await runChecks(
      { repo, provider: svc.provider, budget: svc.budget, log: svc.log, now, market: svc.cfg.market },
      [{ watch, user, mode }],
      {
        apiBudget: BUDGET.MANUAL_API_REQUESTS,
        maxResponseBytes: BUDGET.TICK_MAX_RESPONSE_BYTES * 2,
        reserveSubrequests: BUDGET.RESERVE_FOR_WRITES,
        deadline: Date.now() + BUDGET.MANUAL_DEADLINE_MS,
      },
    );
    if (report.abort === 'auth') {
      await notifyAdmin(svc, 'tp_auth', 'Travelpayouts ответил 401/403: неверный TRAVELPAYOUTS_TOKEN.');
    }
    if (report.deferred.includes(watchId)) {
      await repo.batch([
        repo.stmtEnqueue({ userId: user.id, watchId, kind: 'reply', payload: { text: `⏳ Не успел проверить #${watchId} прямо сейчас — первая проверка пройдёт в ближайшие 15 минут.` }, now: now.toISOString() }),
      ]);
    }
  }
  await dispatchOutbox(
    { repo, messenger: svc.messenger, budget: svc.budget, log: svc.log, now, marker: svc.cfg.marker },
    { maxMessages: 3, userId: user.id, reserveSubrequests: 1 },
  );
}
