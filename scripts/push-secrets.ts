/**
 * Заливает секреты Worker из .dev.vars одной командой (`wrangler secret bulk`).
 * Если нет TELEGRAM_WEBHOOK_SECRET — генерирует и сохраняет в .dev.vars.
 * Заодно кладёт BOT_INFO (ответ getMe), чтобы Worker не тратил на него запрос при холодном старте.
 *
 *   npm run secrets:push
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readDevVars, requireVars, setDevVar } from './lib/devvars.ts';

const SECRET_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TRAVELPAYOUTS_TOKEN', 'ALLOWED_USERNAMES', 'ADMIN_USERNAME', 'TRAVELPAYOUTS_MARKER'];

const vars = readDevVars();
if (!vars.TELEGRAM_WEBHOOK_SECRET) {
  vars.TELEGRAM_WEBHOOK_SECRET = randomBytes(32).toString('base64url');
  setDevVar('TELEGRAM_WEBHOOK_SECRET', vars.TELEGRAM_WEBHOOK_SECRET);
  console.log('Сгенерирован TELEGRAM_WEBHOOK_SECRET (сохранён в .dev.vars).');
}
requireVars(vars, ['TELEGRAM_BOT_TOKEN', 'TRAVELPAYOUTS_TOKEN', 'ALLOWED_USERNAMES']);

const secrets: Record<string, string> = {};
for (const k of SECRET_KEYS) if (vars[k]) secrets[k] = vars[k]!;

const me = (await fetch(`https://api.telegram.org/bot${vars.TELEGRAM_BOT_TOKEN}/getMe`).then((r) => r.json())) as { ok: boolean; result?: unknown; description?: string };
if (!me.ok) {
  console.error(`Telegram отклонил TELEGRAM_BOT_TOKEN: ${me.description ?? 'unknown error'}`);
  process.exit(1);
}
secrets.BOT_INFO = JSON.stringify(me.result);

console.log(`Загружаю секреты: ${Object.keys(secrets).join(', ')}`);
const res = spawnSync('npx', ['wrangler', 'secret', 'bulk'], { input: JSON.stringify(secrets), stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(res.status ?? 1);
