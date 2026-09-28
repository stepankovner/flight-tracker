/**
 * Вариант C (SPEC §2.3): тот же бот и те же задачи в Node ≥ 22.18 / 24 без Cloudflare.
 * SQLite-файл через node:sqlite, long polling вместо webhook (не нужен публичный HTTPS),
 * встроенный планировщик вместо Cron Triggers. Запуск: `node src/node/main.ts` (см. Dockerfile).
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot } from '../bot/bot.ts';
import { NodeSqliteDatabase } from '../db/nodeSqlite.ts';
import { runDaily } from '../jobs/daily.ts';
import { runTick } from '../jobs/tick.ts';
import { loadConfig, type ExecCtx } from '../platform/env.ts';
import { consoleLogger as log, errorMessage } from '../platform/log.ts';
import { createServices } from '../services.ts';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const db = new NodeSqliteDatabase(process.env.DB_PATH ?? './data/farewatch.db');
const applied = db.migrate(MIGRATIONS);
if (applied.length) log.info('migrations applied', { applied });

// webhook-секрет в режиме polling не используется, но нужен валидатору конфигурации
const cfg = loadConfig({ TELEGRAM_WEBHOOK_SECRET: randomBytes(24).toString('base64url'), ...process.env });

const pending = new Set<Promise<unknown>>();
const ctx: ExecCtx = {
  waitUntil(p) {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  },
};

async function tg<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

let stopping = false;
const abort = new AbortController();

async function poll(botInfo: UserFromGetMe): Promise<void> {
  // polling и webhook взаимоисключающие
  await tg('deleteWebhook', { drop_pending_updates: false });
  let offset = 0;
  let backoff = 1;
  while (!stopping) {
    try {
      const updates = await tg<Update[]>(
        'getUpdates',
        { offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'my_chat_member'] },
        abort.signal,
      );
      backoff = 1;
      for (const u of updates) {
        offset = u.update_id + 1;
        // как в Worker: отдельные сервисы (и бюджет) на каждый апдейт
        const bot = createBot(createServices(cfg, db, ctx), botInfo);
        await bot.handleUpdate(u).catch((e) => log.error('update failed', { error: errorMessage(e) }));
      }
    } catch (e) {
      if (stopping) break;
      log.warn('getUpdates failed', { error: errorMessage(e), retryInSec: backoff });
      await new Promise((r) => setTimeout(r, backoff * 1000));
      backoff = Math.min(backoff * 2, 60);
    }
  }
}

let jobRunning = false;
async function runJob(kind: 'tick' | 'daily'): Promise<void> {
  if (jobRunning) return;
  jobRunning = true;
  try {
    const svc = createServices(cfg, db, ctx);
    if (kind === 'daily') await runDaily(svc);
    else await runTick(svc);
  } catch (e) {
    log.error(`${kind} failed`, { error: errorMessage(e) });
  } finally {
    jobRunning = false;
  }
}

/** Те же расписания, что в wrangler.toml: каждые 15 минут и в 03:07 UTC. */
function schedule(): NodeJS.Timeout {
  let lastMinute = -1;
  return setInterval(() => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === lastMinute) return;
    lastMinute = minute;
    if (now.getUTCHours() === 3 && now.getUTCMinutes() === 7) void runJob('daily');
    else if (now.getUTCMinutes() % 15 === 0) void runJob('tick');
  }, 5_000);
}

const me = await tg<UserFromGetMe>('getMe', {});
log.info('FareWatch (node) started', { bot: me.username, db: process.env.DB_PATH ?? './data/farewatch.db', dryRun: cfg.dryRun });
const timer = schedule();
void runJob('tick');

async function shutdown(signal: string): Promise<void> {
  log.info('shutting down', { signal });
  stopping = true;
  abort.abort();
  clearInterval(timer);
  await Promise.allSettled([...pending]);
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await poll(me);
