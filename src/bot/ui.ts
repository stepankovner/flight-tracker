import type { Context } from 'grammy';
import type { Button, Keyboard } from '../core/format.ts';
import type { User } from '../core/types.ts';
import type { Services } from '../services.ts';

export type BotContext = Context & { svc: Services; user: User };

export const btn = (text: string, data: string): Button => ({ text, callback_data: data });
export const urlBtn = (text: string, url: string): Button => ({ text, url });

export const markup = (rows: Keyboard) => ({ inline_keyboard: rows });

export const CANCEL_ROW: Button[] = [btn('✖️ Отмена', 'w:x')];
export const BACK_CANCEL_ROW: Button[] = [btn('← Назад', 'w:b'), btn('✖️ Отмена', 'w:x')];

/**
 * Показать экран: при нажатии кнопки — редактируем то же сообщение, иначе — новое.
 * «message is not modified» от Telegram игнорируем.
 */
export async function show(ctx: BotContext, text: string, rows: Keyboard = [], opts: { edit?: boolean } = {}): Promise<void> {
  const extra = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, reply_markup: markup(rows) };
  if (opts.edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch (e) {
      if (String((e as Error)?.message).includes('message is not modified')) return;
      // сообщение слишком старое или удалено — пришлём новое
    }
  }
  await ctx.reply(text, extra);
}

/** Ответ на callback (убирает «часики»); ошибки игнорируем — запрос мог устареть. */
export async function ack(ctx: BotContext, text?: string, alert = false): Promise<void> {
  if (!ctx.callbackQuery) return;
  try {
    await ctx.answerCallbackQuery(text ? { text, show_alert: alert } : undefined);
  } catch {
    // callback query is too old — не страшно
  }
}

/** Убрать клавиатуру у сообщения, на котором нажали кнопку. */
export async function dropKeyboard(ctx: BotContext): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // уже без клавиатуры / слишком старое
  }
}

/** Разбор числового id из аргумента команды: «/check 12», «/check #12». */
export function parseId(arg: string | undefined): number | null {
  const m = /^#?(\d{1,9})$/.exec((arg ?? '').trim());
  return m ? Number(m[1]) : null;
}
