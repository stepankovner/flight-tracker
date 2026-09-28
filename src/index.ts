import { webhookCallback } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { createBot } from './bot/bot.ts';
import { notifyAdmin } from './jobs/admin.ts';
import { runDaily } from './jobs/daily.ts';
import { runTick } from './jobs/tick.ts';
import { loadConfig, webhookPath, type Env, type ExecCtx, type ScheduledEvt } from './platform/env.ts';
import { consoleLogger, errorMessage } from './platform/log.ts';
import { createServices, type Services } from './services.ts';

// Только роутинг: webhook Telegram → бот, cron → задачи (SPEC §11).

export const DAILY_CRON = '7 3 * * *';

let cachedBotInfo: UserFromGetMe | null = null;

/** getMe один раз на изолят (или из BOT_INFO) — экономит subrequest на каждом апдейте. */
async function getBotInfo(svc: Services): Promise<UserFromGetMe> {
  if (svc.cfg.botInfo) return svc.cfg.botInfo as UserFromGetMe;
  if (cachedBotInfo) return cachedBotInfo;
  const res = await svc.fetch(`https://api.telegram.org/bot${svc.cfg.botToken}/getMe`);
  const data = (await res.json()) as { ok: boolean; result?: UserFromGetMe; description?: string };
  if (!data.ok || !data.result) throw new Error(`getMe failed: ${data.description ?? res.status}`);
  cachedBotInfo = data.result;
  return cachedBotInfo;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const notFound = () => new Response('Not found', { status: 404 });

export async function handleFetch(request: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || !url.pathname.startsWith('/tg/')) return notFound();

  let cfg;
  try {
    cfg = loadConfig(env as unknown as Record<string, unknown>);
  } catch (e) {
    consoleLogger.error('config error', { error: errorMessage(e) });
    return new Response('Misconfigured', { status: 500 });
  }
  if (url.pathname !== (await webhookPath(cfg.webhookSecret))) return notFound();
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!timingSafeEqual(secret, cfg.webhookSecret)) return notFound();

  const svc = createServices(cfg, env.DB, ctx);
  try {
    const bot = createBot(svc, await getBotInfo(svc));
    // onTimeout 'return': Telegram получит 200, а не станет повторять апдейт
    return await webhookCallback(bot, 'cloudflare-mod', { onTimeout: 'return', timeoutMilliseconds: 25_000 })(request);
  } catch (e) {
    svc.log.error('webhook failed', { error: errorMessage(e) });
    // 200, чтобы Telegram не заваливал повторами одного и того же апдейта
    return new Response('ok', { status: 200 });
  }
}

export async function handleScheduled(event: ScheduledEvt, env: Env, ctx: ExecCtx): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(env as unknown as Record<string, unknown>);
  } catch (e) {
    consoleLogger.error('config error', { error: errorMessage(e) });
    return;
  }
  const svc = createServices(cfg, env.DB, ctx, { now: () => new Date() });
  const job = event.cron === DAILY_CRON ? 'daily' : 'tick';
  try {
    if (job === 'daily') await runDaily(svc);
    else await runTick(svc);
  } catch (e) {
    const msg = errorMessage(e);
    svc.log.error(`${job} failed`, { error: msg });
    await notifyAdmin(svc, `${job}:${msg.slice(0, 60)}`, `Задача ${job} упала: ${msg}`, 180);
  }
}

export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
};
