/**
 * Регистрирует webhook Telegram на Worker (с secret_token) и меню команд.
 *
 *   npm run set-webhook                       # URL из WORKER_URL в .dev.vars
 *   npm run set-webhook -- --url https://farewatch.<sub>.workers.dev
 *   npm run set-webhook -- --info             # только показать состояние
 *   npm run set-webhook -- --delete           # снять webhook
 */
import { BOT_COMMANDS } from '../src/bot/bot.ts';
import { webhookPath } from '../src/platform/env.ts';
import { readDevVars, requireVars, setDevVar } from './lib/devvars.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const vars = readDevVars();
requireVars(vars, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET']);
const api = async (method: string, body?: unknown) => {
  const res = await fetch(`https://api.telegram.org/bot${vars.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
};

if (flag('delete')) {
  await api('deleteWebhook', { drop_pending_updates: false });
  console.log('Webhook снят.');
  process.exit(0);
}

if (!flag('info')) {
  const base = (option('url') ?? vars.WORKER_URL ?? '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) {
    console.error('Укажи URL Worker: npm run set-webhook -- --url https://farewatch.<subdomain>.workers.dev (или WORKER_URL в .dev.vars)');
    process.exit(1);
  }
  if (option('url')) setDevVar('WORKER_URL', base);
  const url = `${base}${await webhookPath(vars.TELEGRAM_WEBHOOK_SECRET!)}`;
  await api('setWebhook', {
    url,
    secret_token: vars.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    max_connections: 10,
  });
  await api('setMyCommands', { commands: BOT_COMMANDS });
  console.log(`Webhook установлен: ${base}/tg/…`);
}

const info = (await api('getWebhookInfo')) as Record<string, unknown>;
const safe = { ...info, url: typeof info.url === 'string' ? info.url.replace(/\/tg\/.+$/, '/tg/…') : info.url };
console.log(JSON.stringify(safe, null, 2));
