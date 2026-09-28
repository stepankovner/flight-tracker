import { offerKey } from '../core/filters.ts';
import { renderAlert, type AlertPayload } from '../core/format.ts';
import { ack, markup, type BotContext } from './ui.ts';

/** Кнопки в уведомлениях: a:more:<outboxId> / a:mute:<outboxId>:<idx> / a:pause:<watchId> */
export async function handleAlertCallback(ctx: BotContext, data: string): Promise<void> {
  const { svc, user } = ctx;
  const [, action, a1, a2] = data.split(':');
  const nowIso = svc.now().toISOString();

  if (action === 'pause') {
    const id = Number(a1);
    const w = await svc.repo.getWatchForUser(user.id, id);
    if (!w) return ack(ctx, 'Наблюдение не найдено', true);
    if (w.status === 'paused') return ack(ctx, `#${id} уже на паузе. Включить — в /list`, true);
    await svc.repo.setWatchStatus(id, 'paused', nowIso);
    return ack(ctx, `⏸ #${id} на паузе. Включить обратно — в /list`, true);
  }

  const item = await svc.repo.getOutboxItem(Number(a1), user.id);
  let payload: AlertPayload | null = null;
  try {
    payload = item ? (JSON.parse(item.payload) as AlertPayload) : null;
  } catch {
    payload = null;
  }
  if (!item || !payload?.offers) return ack(ctx, 'Это уведомление уже устарело', true);

  if (action === 'more') {
    await ack(ctx);
    const codes = payload.offers.flatMap((a) => [a.offer.originAirport, a.offer.destAirport]);
    const names = await svc.repo.getNames([...payload.origins, ...payload.destinations, ...codes], payload.offers.map((a) => a.offer.airline));
    const r = renderAlert(payload, { names, now: svc.now(), marker: svc.cfg.marker, outboxId: item.id }, true);
    await ctx.reply(r.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup(r.keyboard) });
    return;
  }

  if (action === 'mute') {
    const a = payload.offers[Number(a2)];
    if (!a || item.watchId === null) return ack(ctx);
    await svc.repo.muteOffer(item.watchId, offerKey(a.offer), a.offer.price, a.offer.departAt.slice(0, 10), nowIso);
    return ack(ctx, '🔕 Больше не покажу этот рейс на эти даты', true);
  }
  return ack(ctx);
}
