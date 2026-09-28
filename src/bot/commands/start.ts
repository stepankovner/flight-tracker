import { APP_NAME, BOT, DETECTOR } from '../../config.ts';
import { escapeHtml } from '../../core/format.ts';
import { btn, show, type BotContext } from '../ui.ts';

export const MAIN_MENU = [[btn('➕ Новое наблюдение', 'm:new')], [btn('📋 Мои наблюдения', 'm:list'), btn('⚙️ Настройки', 'm:settings')]];

export async function cmdStart(ctx: BotContext): Promise<void> {
  const name = ctx.from?.first_name ? `, ${escapeHtml(ctx.from.first_name)}` : '';
  const botName = escapeHtml(ctx.me?.first_name || APP_NAME);
  await show(
    ctx,
    `👋 Привет${name}! Я <b>${botName}</b> — слежу за ценами на авиабилеты Aviasales и пишу, когда становится дёшево.\n\n` +
      '<b>Как это работает</b>\n' +
      '1. /new — создаёшь наблюдение: откуда, куда, окно дат, сколько ночей, фильтры и порог цены (или «пусть бот решает сам»).\n' +
      `2. Раз в ${BOT.DEFAULT_CHECK_INTERVAL_MIN} минут я проверяю цены и присылаю уведомление, если билет дешевле порога ` +
      `или заметно дешевле обычного (−${Math.round(DETECTOR.DEFAULT_SENSITIVITY * 100)}% к медиане).\n` +
      '3. /list — список наблюдений: пауза, правка, удаление, проверка прямо сейчас.\n\n' +
      '/help — форматы ввода и ограничения данных · /settings — часовой пояс, тихие часы, лимит уведомлений.',
    MAIN_MENU,
  );
}
