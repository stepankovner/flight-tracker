import { Bot, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { BOT } from '../config.ts';
import { notifyAdmin } from '../jobs/admin.ts';
import { errorMessage, type Logger } from '../platform/log.ts';
import type { Services } from '../services.ts';
import { handleAlertCallback } from './alerts.ts';
import { cmdHelp } from './commands/help.ts';
import { cmdHistory } from './commands/history.ts';
import { checkNow, cmdList, handleListCallback } from './commands/list.ts';
import { cmdSettings, handleSettingsCallback, handleSettingsText } from './commands/settings.ts';
import { cmdStart } from './commands/start.ts';
import { cmdStatus } from './commands/status.ts';
import { ack, parseId, type BotContext } from './ui.ts';
import { cancelWizard, handleWizardCallback, handleWizardText, loadWizard, startWizard } from './wizard.ts';

export const BOT_COMMANDS = [
  { command: 'new', description: 'Новое наблюдение' },
  { command: 'list', description: 'Мои наблюдения' },
  { command: 'check', description: 'Проверить наблюдение сейчас: /check N' },
  { command: 'history', description: 'История цен: /history N' },
  { command: 'settings', description: 'Часовой пояс, тихие часы, лимит' },
  { command: 'help', description: 'Форматы ввода и ограничения' },
  { command: 'cancel', description: 'Выйти из мастера' },
];

const DENIED_TEXT = 'Извини, это закрытый бот.';

/** В режиме DRY_RUN не отправляем ничего в Telegram — только логируем. */
function dryRunTransformer(log: Logger): Transformer {
  return async (prev, method, payload, signal) => {
    if (/^(send|edit|answer|delete|set)/.test(method)) {
      log.info(`DRY_RUN ${method}`, { payload: payload as Record<string, unknown> });
      const chatId = (payload as { chat_id?: number }).chat_id ?? 0;
      const result = method.startsWith('send')
        ? { message_id: 0, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: '' }
        : true;
      return { ok: true, result } as never;
    }
    return prev(method, payload, signal);
  };
}

export function createBot(svc: Services, botInfo: UserFromGetMe): Bot<BotContext> {
  const bot = new Bot<BotContext>(svc.cfg.botToken, { botInfo, client: { fetch: svc.fetch as never } });
  if (svc.cfg.dryRun) bot.api.config.use(dryRunTransformer(svc.log));

  // Пользователь заблокировал/разблокировал бота
  bot.on('my_chat_member', async (ctx) => {
    const u = await svc.repo.getUserByTgId(ctx.from.id);
    if (!u) return;
    const blocked = ctx.myChatMember.new_chat_member.status === 'kicked';
    await svc.repo.batch([svc.repo.stmtSetUserBlocked(u.id, blocked, svc.now().toISOString())]);
  });

  // Доступ: только личные чаты и allowlist (по username, а после привязки — и по tg_user_id)
  bot.use(async (ctx, next) => {
    ctx.svc = svc;
    if (ctx.chat && ctx.chat.type !== 'private') return;
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const username = from.username?.toLowerCase() ?? null;
    let user = await svc.repo.getUserByTgId(from.id);
    const allowed =
      (username !== null && svc.cfg.allowedUsernames.has(username)) ||
      (user?.boundUsername != null && svc.cfg.allowedUsernames.has(user.boundUsername));
    if (!allowed) {
      svc.log.warn('access denied', { tgUserId: from.id });
      if (ctx.callbackQuery) await ack(ctx, DENIED_TEXT, true);
      else if (ctx.message) await ctx.reply(DENIED_TEXT);
      return;
    }
    const now = svc.now().toISOString();
    const chatId = ctx.chat?.id ?? from.id;
    if (!user || user.isBlocked || user.chatId !== chatId || /^\/start\b/.test(ctx.message?.text ?? '')) {
      user = await svc.repo.upsertUserOnStart({ tgUserId: from.id, chatId, username, now, tz: BOT.DEFAULT_TZ, currency: svc.cfg.currency, cap: BOT.DEFAULT_DAILY_CAP });
    } else if (user.username !== username) {
      await svc.repo.updateUsername(user.id, username, now);
      user = { ...user, username };
    }
    ctx.user = user;
    await next();
  });

  bot.command('start', async (ctx) => {
    await ctx.svc.repo.clearWizard(ctx.user.tgUserId);
    await cmdStart(ctx);
  });
  bot.command('help', cmdHelp);
  bot.command('new', startWizard);
  bot.command('list', (ctx) => cmdList(ctx));
  bot.command('settings', (ctx) => cmdSettings(ctx));
  bot.command('status', cmdStatus);
  bot.command('history', (ctx) => cmdHistory(ctx, ctx.match));
  bot.command('cancel', async (ctx) => {
    if (await loadWizard(ctx)) return cancelWizard(ctx, false);
    await ctx.svc.repo.clearWizard(ctx.user.tgUserId);
    await ctx.reply('Нечего отменять. /new — новое наблюдение.');
  });
  bot.command('check', async (ctx) => {
    let id = parseId(ctx.match);
    if (id === null) {
      const active = (await ctx.svc.repo.listWatches(ctx.user.id)).filter((w) => w.status === 'active');
      if (active.length === 1) id = active[0]!.id;
      else return void (await ctx.reply('Укажи номер наблюдения: /check 12 (номера — в /list).'));
    }
    await checkNow(ctx, id);
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith('w:')) return handleWizardCallback(ctx, data);
    if (data.startsWith('l:')) return handleListCallback(ctx, data);
    if (data.startsWith('a:')) return handleAlertCallback(ctx, data);
    if (data.startsWith('s:')) return handleSettingsCallback(ctx, data);
    if (data === 'm:new') {
      await ack(ctx);
      return startWizard(ctx);
    }
    if (data === 'm:list') {
      await ack(ctx);
      return cmdList(ctx);
    }
    if (data === 'm:settings') {
      await ack(ctx);
      return cmdSettings(ctx);
    }
    await ack(ctx);
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply('Не знаю такой команды. /help — список команд.');
      return;
    }
    if (await handleWizardText(ctx, text)) return;
    if (await handleSettingsText(ctx, text)) return;
    await ctx.reply('Чтобы создать наблюдение — /new, список — /list, справка — /help.');
  });

  bot.on('message', (ctx) => ctx.reply('Я понимаю только текст и кнопки.'));

  bot.catch(async (err) => {
    const ctx = err.ctx as BotContext;
    const msg = errorMessage(err.error);
    svc.log.error('bot handler failed', { error: msg, update: ctx.update.update_id });
    try {
      if (ctx.callbackQuery) await ack(ctx, 'Что-то пошло не так, попробуй ещё раз', true);
      else if (ctx.chat) await ctx.reply('⚠️ Что-то пошло не так. Попробуй ещё раз; если повторится — админ уже в курсе.');
    } catch {
      // Telegram может быть недоступен — ничего не делаем
    }
    await notifyAdmin(svc, `bot:${msg.slice(0, 60)}`, `Ошибка в обработчике бота: ${msg}`, 60);
  });

  return bot;
}
