import * as z from 'zod/mini';
import { PROVIDER } from '../config.ts';
import type { SqlDatabase } from '../db/sql.ts';

/** Биндинги и переменные Worker (секреты — через `wrangler secret`, см. README). */
export interface Env {
  DB: SqlDatabase;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TRAVELPAYOUTS_TOKEN: string;
  ALLOWED_USERNAMES: string;
  ADMIN_USERNAME?: string;
  TRAVELPAYOUTS_MARKER?: string;
  DEFAULT_CURRENCY?: string;
  MARKET?: string;
  DRY_RUN?: string;
  /** JSON getMe — необязательно; экономит один запрос на холодном старте. */
  BOT_INFO?: string;
}

/** Минимальные типы рантайма Workers — чтобы ядро и Node-вариант не зависели от @cloudflare/workers-types. */
export interface ExecCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledEvt {
  cron: string;
  scheduledTime: number;
}

export interface AppConfig {
  botToken: string;
  webhookSecret: string;
  tpToken: string;
  marker: string | null;
  allowedUsernames: Set<string>;
  adminUsername: string | null;
  currency: string;
  market: string;
  dryRun: boolean;
  botInfo: unknown | null;
}

const normUsername = (s: string) => s.trim().replace(/^@/, '').toLowerCase();

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().check(z.regex(/^\d+:[\w-]{20,}$/, 'выглядит не как токен BotFather')),
  TELEGRAM_WEBHOOK_SECRET: z.string().check(z.regex(/^[A-Za-z0-9_-]{16,256}$/, '16–256 символов A-Z a-z 0-9 _ -')),
  TRAVELPAYOUTS_TOKEN: z.string().check(z.minLength(16, 'слишком короткий')),
  ALLOWED_USERNAMES: z.string().check(z.minLength(1, 'пусто')),
  ADMIN_USERNAME: z.optional(z.string()),
  TRAVELPAYOUTS_MARKER: z.optional(z.string()),
  DEFAULT_CURRENCY: z.optional(z.string().check(z.regex(/^[a-zA-Z]{3}$/))),
  MARKET: z.optional(z.string().check(z.regex(/^[a-zA-Z]{2}$/))),
  DRY_RUN: z.optional(z.string()),
  BOT_INFO: z.optional(z.string()),
});

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, unknown>): AppConfig {
  const r = EnvSchema.safeParse(env);
  if (!r.success) {
    // не печатаем значения — только имена полей
    const fields = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${fields}`);
  }
  const e = r.data;
  const allowed = new Set(e.ALLOWED_USERNAMES.split(/[,\s]+/).map(normUsername).filter(Boolean));
  const admin = e.ADMIN_USERNAME ? normUsername(e.ADMIN_USERNAME) || null : null;
  if (admin) allowed.add(admin);
  let botInfo: unknown = null;
  if (e.BOT_INFO) {
    try {
      botInfo = JSON.parse(e.BOT_INFO);
    } catch {
      botInfo = null;
    }
  }
  return {
    botToken: e.TELEGRAM_BOT_TOKEN,
    webhookSecret: e.TELEGRAM_WEBHOOK_SECRET,
    tpToken: e.TRAVELPAYOUTS_TOKEN,
    marker: e.TRAVELPAYOUTS_MARKER?.trim() || null,
    allowedUsernames: allowed,
    adminUsername: admin,
    currency: (e.DEFAULT_CURRENCY ?? 'rub').toLowerCase(),
    market: (e.MARKET ?? PROVIDER.DEFAULT_MARKET).toLowerCase(),
    dryRun: e.DRY_RUN === '1' || e.DRY_RUN === 'true',
    botInfo,
  };
}

/** Путь вебхука: /tg/<32 hex>, производный от секрета — отдельная переменная не нужна. */
export async function webhookPath(secret: string): Promise<string> {
  const data = new TextEncoder().encode(`farewatch-webhook:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `/tg/${hex.slice(0, 32)}`;
}
