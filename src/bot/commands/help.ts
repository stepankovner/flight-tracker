import { BOT, NOTIFY, PLANNER } from '../../config.ts';
import { DETECTOR_HELP } from '../../core/format.ts';
import type { BotContext } from '../ui.ts';

export const HELP_TEXT =
  '<b>Команды</b>\n' +
  '/new — новое наблюдение\n' +
  '/list — мои наблюдения (пауза, правка, удаление, проверка сейчас)\n' +
  '/check <i>N</i> — проверить наблюдение #N сейчас (раз в 5 минут)\n' +
  '/history <i>N</i> — минимальные цены по дням за 30 дней\n' +
  '/settings — часовой пояс, тихие часы, дневной лимит\n' +
  '/cancel — выйти из мастера\n\n' +
  '<b>Форматы ввода</b>\n' +
  '• Города: «Москва», «MOW», «Москва, Питер». Код города (MOW) покрывает все его аэропорты.\n' +
  '• Даты вылета: <code>15.11-30.11</code>, <code>15.11.2026-02.12.2026</code>, <code>ноябрь</code>, ' +
  '<code>ноябрь-декабрь</code>, <code>15.11</code>, <code>±3 от 20.11</code>. Год — ближайший будущий.\n' +
  '• Ночей: <code>7</code>, <code>5-9</code>.\n' +
  '• Цена: <code>12000</code>, <code>12 000</code>, <code>12к</code> — за 1 взрослого.\n\n' +
  '<b>Откуда данные и чем они ограничены</b>\n' +
  '• Цены берутся из официального API Aviasales (Travelpayouts) — это <b>кэш поисков других пользователей</b> ' +
  'за последние ~48 часов, а не живой поиск. Цена могла измениться — проверяй перед покупкой по кнопке «Купить».\n' +
  '• Для редких направлений данных бывает мало: билет может не находиться, хотя на сайте он есть, ' +
  'а авто-режим будет осторожным, пока не накопится история.\n' +
  `• ${DETECTOR_HELP}\n` +
  `• Повторно про тот же рейс пишу, только если цена упала ещё на ${Math.round(NOTIFY.REALERT_MIN_DROP_PCT * 100)}% и ${NOTIFY.REALERT_MIN_DROP_ABS} ₽.\n` +
  `• Лимиты: до ${BOT.MAX_ACTIVE_WATCHES} активных наблюдений, до ${PLANNER.MAX_QUERIES_PER_WATCH} запросов к API на одно наблюдение ` +
  '(если больше — сузь даты или число городов).';

export async function cmdHelp(ctx: BotContext): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}
