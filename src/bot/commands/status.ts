import { addDays } from '../../core/dates.ts';
import type { BotContext } from '../ui.ts';

/** /status — только для админа: счётчики и состояние планировщика. */
export async function cmdStatus(ctx: BotContext): Promise<void> {
  const { svc, user } = ctx;
  const admin = svc.cfg.adminUsername;
  if (!admin || (user.username !== admin && user.boundUsername !== admin)) {
    await ctx.reply('Команда только для администратора.');
    return;
  }
  const today = svc.now().toISOString().slice(0, 10);
  const [t, y, active, kv] = await Promise.all([
    svc.repo.getCounters(today),
    svc.repo.getCounters(addDays(today, -1)),
    svc.repo.countActiveAll(),
    svc.repo.getKv(['last_tick_at', 'rate_limited_until', 'rate_limit_level', 'airlines_at']),
  ]);
  const fmt = (c: Record<string, number>) =>
    `API ${c.api_requests ?? 0} (ошибок ${c.api_errors ?? 0}) · проверок ${c.checks ?? 0} · тиков ${c.ticks ?? 0} · ` +
    `алертов ${c.alerts ?? 0} · сообщений ${c.tg_sent ?? 0} (ошибок ${c.tg_errors ?? 0})`;
  const rl = kv.get('rate_limited_until');
  const lines = [
    '🛠 <b>Статус</b>',
    `активных watch (все пользователи): ${active}`,
    `последний тик: ${kv.get('last_tick_at') ?? 'ещё не было'}`,
    rl && Date.parse(rl) > svc.now().getTime() ? `⚠️ пауза API до ${rl} (уровень ${kv.get('rate_limit_level')})` : 'API: без ограничений',
    `справочник авиакомпаний: ${kv.get('airlines_at') ?? 'не загружен'}`,
    '',
    `<b>Сегодня (UTC):</b> ${fmt(t)}`,
    `<b>Вчера:</b> ${fmt(y)}`,
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}
