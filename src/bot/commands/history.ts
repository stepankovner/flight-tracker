import { DETECTOR } from '../../config.ts';
import { addDays } from '../../core/dates.ts';
import { fmtDate, fmtPrice, routeTitle } from '../../core/format.ts';
import { computeStats, median } from '../../core/priceDetector.ts';
import { parseId, type BotContext } from '../ui.ts';

const SPARK = '▁▂▃▄▅▆▇█';

/** Мини-график: один символ на день, «·» — нет данных. */
export function sparkline(values: Array<number | null>): string {
  const nums = values.filter((v): v is number => v !== null);
  if (!nums.length) return '';
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return values
    .map((v) => (v === null ? '·' : SPARK[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * (SPARK.length - 1))]))
    .join('');
}

export async function cmdHistory(ctx: BotContext, arg: string | undefined): Promise<void> {
  const { repo } = ctx.svc;
  let id = parseId(arg);
  if (id === null) {
    const list = (await repo.listWatches(ctx.user.id)).filter((w) => w.status !== 'deleted');
    if (list.length === 1) id = list[0]!.id;
    else return void (await ctx.reply('Укажи номер наблюдения: /history 12 (номера — в /list).'));
  }
  const w = await repo.getWatchForUser(ctx.user.id, id);
  if (!w) return void (await ctx.reply(`Наблюдение #${id} не найдено. Список — /list`));

  const todayUtc = ctx.svc.now().toISOString().slice(0, 10);
  const since = addDays(todayUtc, -29);
  const [points, names] = await Promise.all([
    repo.dailyMinHistory(w.id, addDays(todayUtc, -DETECTOR.BASELINE_WINDOW_DAYS - 30)),
    repo.getNames([...w.origins, ...w.destinations], []),
  ]);
  const cur = ctx.user.currency;
  const last30 = points.filter((p) => p.day >= since);
  const header = `📈 <b>#${w.id} ${routeTitle(w.origins, w.destinations, names)}</b> — минимальные цены по дням`;
  if (!last30.length) {
    return void (await ctx.reply(`${header}\n\nЗа последние 30 дней данных нет — подходящих билетов в кэше Aviasales не находилось.`, { parse_mode: 'HTML' }));
  }
  const prices = last30.map((p) => p.minPrice);
  const byDay = new Map(last30.map((p) => [p.day, p.minPrice]));
  const series: Array<number | null> = [];
  for (let d = since; d <= todayUtc; d = addDays(d, 1)) series.push(byDay.get(d) ?? null);

  const stats = computeStats(points, todayUtc, w.bootstrapBaseline);
  const lines = [
    header,
    '',
    `За 30 дней (дней с данными: ${last30.length}):`,
    `мин <b>${fmtPrice(Math.min(...prices), cur)}</b> · медиана ${fmtPrice(median(prices)!, cur)} · макс ${fmtPrice(Math.max(...prices), cur)}`,
    `<code>${sparkline(series)}</code>`,
    '',
    'Последние 7 дней:',
  ];
  for (let i = 0; i < 7; i++) {
    const d = addDays(todayUtc, -i);
    const v = byDay.get(d);
    lines.push(`${fmtDate(d)} — ${v !== undefined ? fmtPrice(v, cur) : '—'}`);
  }
  if (w.priceMode !== 'threshold') {
    lines.push('');
    if (stats.confidence === 'high') lines.push(`🤖 Авто-режим: медиана за ${DETECTOR.BASELINE_WINDOW_DAYS} дн. — ${fmtPrice(stats.baseline!, cur)}.`);
    else if (stats.confidence === 'low') lines.push(`🤖 Авто-режим: истории пока мало, ориентир по календарю Aviasales ≈ ${fmtPrice(stats.baseline!, cur)}.`);
    else lines.push(`🤖 Авто-режим: копим историю (нужно ≥ ${DETECTOR.BASELINE_MIN_DAYS} дней).`);
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}
