import { BOT } from '../../config.ts';
import { localParts, todayIn } from '../../core/dates.ts';
import { describePrice, escapeHtml, fmtDate, fmtDateRange, fmtPrice, routeTitle, type Keyboard } from '../../core/format.ts';
import type { Watch } from '../../core/types.ts';
import { manualCooldownLeftMin } from '../../jobs/checker.ts';
import { runInitialCheck } from '../../jobs/manual.ts';
import { ack, btn, show, type BotContext } from '../ui.ts';
import { startEdit } from '../wizard.ts';

const STATUS_ICON: Record<Watch['status'], string> = { active: '▶️', paused: '⏸', expired: '🏁', deleted: '🗑' };

function checkedAt(iso: string | null, tz: string, now: Date): string {
  if (!iso) return 'ещё не проверялось';
  const p = localParts(new Date(iso), tz);
  return p.date === todayIn(now, tz) ? `проверено в ${p.time}` : `проверено ${fmtDate(p.date, false)} ${p.time}`;
}

export async function renderList(ctx: BotContext): Promise<{ text: string; keyboard: Keyboard }> {
  const { repo } = ctx.svc;
  const now = ctx.svc.now();
  const watches = await repo.listWatches(ctx.user.id);
  if (!watches.length) {
    return { text: 'Пока нет наблюдений. Создай первое: /new', keyboard: [[btn('➕ Новое наблюдение', 'm:new')]] };
  }
  const names = await repo.getNames(watches.flatMap((w) => [...w.origins, ...w.destinations]), []);
  const cur = ctx.user.currency;
  const lines = [`📋 <b>Наблюдения</b> (${watches.filter((w) => w.status === 'active').length}/${BOT.MAX_ACTIVE_WATCHES} активных)`];
  const keyboard: Keyboard = [];
  for (const w of watches) {
    let dates = fmtDateRange(w.departFrom, w.departTo);
    if (w.tripType === 'roundtrip') dates += ` · ${w.nightsMin === w.nightsMax ? w.nightsMin : `${w.nightsMin}–${w.nightsMax}`} н.`;
    else dates += ' · в одну сторону';
    lines.push('', `<b>#${w.id}</b> ${STATUS_ICON[w.status]} ${routeTitle(w.origins, w.destinations, names)}`);
    lines.push(`   ${dates} · ${describePrice(w, cur)}`);
    const price = w.lastMinPrice !== null ? `💰 сейчас от ${fmtPrice(w.lastMinPrice, cur)}` : w.lastCheckedAt ? '💰 подходящих билетов пока нет' : '';
    const status = w.status === 'expired' ? 'окно вылета прошло' : checkedAt(w.lastCheckedAt, ctx.user.tz, now);
    lines.push(`   ${[price, status].filter(Boolean).join(' · ')}`);
    if (w.lastError && w.errorCount > 0) lines.push(`   ⚠️ ${escapeHtml(w.lastError.slice(0, 120))}`);

    const row = [];
    if (w.status === 'active') row.push(btn(`#${w.id} ⏸`, `l:p:${w.id}`));
    else if (w.status === 'paused') row.push(btn(`#${w.id} ▶️`, `l:r:${w.id}`));
    else row.push(btn(`#${w.id} 🏁`, `l:e:${w.id}`));
    row.push(btn('✏️', `l:e:${w.id}`), btn('🗑', `l:d:${w.id}`));
    if (w.status !== 'expired') row.push(btn('🔄', `l:c:${w.id}`));
    keyboard.push(row);
  }
  keyboard.push([btn('➕ Новое', 'm:new'), btn('↻ Обновить', 'l:refresh')]);
  return { text: lines.join('\n'), keyboard };
}

export async function cmdList(ctx: BotContext, edit = false): Promise<void> {
  const { text, keyboard } = await renderList(ctx);
  await show(ctx, text, keyboard, { edit });
}

/** Ручная проверка — из /check N и кнопки 🔄. */
export async function checkNow(ctx: BotContext, id: number): Promise<void> {
  const { svc, user } = ctx;
  const w = await svc.repo.getWatchForUser(user.id, id);
  if (!w) {
    await ack(ctx, `Наблюдение #${id} не найдено`, true);
    if (!ctx.callbackQuery) await ctx.reply(`Наблюдение #${id} не найдено. Список — /list`);
    return;
  }
  const left = manualCooldownLeftMin(w, svc.now());
  if (left > 0) {
    const msg = `#${id} уже проверялось только что — следующая ручная проверка через ${left} мин.`;
    if (ctx.callbackQuery) await ack(ctx, msg, true);
    else await ctx.reply(msg);
    return;
  }
  if (w.status === 'expired') {
    await ack(ctx);
    await ctx.reply(`Окно вылета #${id} уже прошло — поправь даты через ✏️ в /list.`);
    return;
  }
  await svc.repo.setManualCheckAt(id, svc.now().toISOString());
  await ack(ctx, `Проверяю #${id}…`);
  if (!ctx.callbackQuery) await ctx.reply(`🔄 Проверяю #${id}…`);
  svc.waitUntil(runInitialCheck(svc, id, user, 'manual'));
}

/** Кнопки списка: l:p / l:r / l:e / l:d / l:dy / l:dn / l:c / l:refresh */
export async function handleListCallback(ctx: BotContext, data: string): Promise<void> {
  const { svc, user } = ctx;
  const [, action, arg] = data.split(':');
  if (action === 'refresh' || action === 'dn') {
    await ack(ctx);
    return cmdList(ctx, true);
  }
  const id = Number(arg);
  const w = Number.isFinite(id) ? await svc.repo.getWatchForUser(user.id, id) : null;
  if (!w) {
    await ack(ctx, 'Наблюдение не найдено', true);
    return cmdList(ctx, true);
  }
  const nowIso = svc.now().toISOString();
  switch (action) {
    case 'p':
      await svc.repo.setWatchStatus(id, 'paused', nowIso);
      await ack(ctx, `#${id} на паузе`);
      return cmdList(ctx, true);
    case 'r': {
      const active = await svc.repo.countActiveWatches(user.id);
      if (active >= BOT.MAX_ACTIVE_WATCHES) return ack(ctx, `Уже ${active} активных — это максимум`, true);
      await svc.repo.setWatchStatus(id, 'active', nowIso);
      await ack(ctx, `#${id} снова активно`);
      return cmdList(ctx, true);
    }
    case 'e':
      await ack(ctx);
      return startEdit(ctx, w);
    case 'd': {
      await ack(ctx);
      const names = await svc.repo.getNames([...w.origins, ...w.destinations], []);
      return show(ctx, `Удалить наблюдение <b>#${id}</b> ${routeTitle(w.origins, w.destinations, names)}? История цен тоже удалится.`, [[btn('🗑 Да, удалить', `l:dy:${id}`), btn('Нет', 'l:dn')]], { edit: true });
    }
    case 'dy':
      await svc.repo.setWatchStatus(id, 'deleted', nowIso);
      await ack(ctx, `#${id} удалено`);
      return cmdList(ctx, true);
    case 'c':
      return checkNow(ctx, id);
    default:
      return ack(ctx);
  }
}
