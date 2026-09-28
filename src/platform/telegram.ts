import { NOTIFY } from '../config.ts';
import type { Keyboard } from '../core/format.ts';
import { redact, type Logger } from './log.ts';

export type SendResult =
  | { ok: true; messageId: number | null }
  | { ok: false; kind: 'retry_after'; retryAfterSec: number }
  | { ok: false; kind: 'blocked'; description: string }
  | { ok: false; kind: 'bad_request'; description: string }
  | { ok: false; kind: 'transient'; description: string };

export interface SendOptions {
  keyboard?: Keyboard;
  silent?: boolean;
}

/** Отправка сообщений из фоновых задач (без grammY — дешевле и проще мокать в тестах). */
export interface Messenger {
  send(chatId: number, html: string, opts?: SendOptions): Promise<SendResult>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TelegramMessenger implements Messenger {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly dryRun: boolean;

  constructor(opts: { token: string; fetch: typeof fetch; log: Logger; dryRun: boolean }) {
    this.token = opts.token;
    this.fetchImpl = opts.fetch;
    this.log = opts.log;
    this.dryRun = opts.dryRun;
  }

  async send(chatId: number, html: string, opts: SendOptions = {}): Promise<SendResult> {
    if (this.dryRun) {
      this.log.info('DRY_RUN sendMessage', { chatId, silent: !!opts.silent, text: html, keyboard: opts.keyboard ?? [] });
      return { ok: true, messageId: null };
    }
    const body = {
      chat_id: chatId,
      text: html.length > 4096 ? `${html.slice(0, 4090)}…` : html,
      parse_mode: 'HTML',
      disable_notification: !!opts.silent,
      link_preview_options: { is_disabled: true },
      ...(opts.keyboard?.length ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
    };
    let r = await this.call('sendMessage', body);
    if (!r.ok && r.kind === 'retry_after' && r.retryAfterSec <= NOTIFY.MAX_INLINE_RETRY_AFTER_SEC) {
      await sleep(r.retryAfterSec * 1000);
      r = await this.call('sendMessage', body);
    }
    return r;
  }

  private async call(method: string, body: unknown): Promise<SendResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      return { ok: false, kind: 'transient', description: redact(String((e as Error)?.message ?? e)) };
    }
    let data: { ok?: boolean; result?: { message_id?: number }; description?: string; parameters?: { retry_after?: number } } = {};
    try {
      data = await res.json();
    } catch {
      // тело не JSON — решаем по статусу
    }
    if (res.ok && data.ok) return { ok: true, messageId: data.result?.message_id ?? null };
    const description = redact(data.description ?? `HTTP ${res.status}`);
    if (res.status === 429) return { ok: false, kind: 'retry_after', retryAfterSec: data.parameters?.retry_after ?? 5 };
    if (res.status === 403) return { ok: false, kind: 'blocked', description };
    if (res.status === 400) {
      // «chat not found» — тоже фактически недоставляемо
      return { ok: false, kind: /chat not found|user is deactivated/i.test(description) ? 'blocked' : 'bad_request', description };
    }
    return { ok: false, kind: 'transient', description };
  }
}
