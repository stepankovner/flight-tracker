import { BOT } from '../../config.ts';
import { isValidTimeZone, localParts } from '../../core/dates.ts';
import { parseTimeWindow } from '../../core/dateParser.ts';
import { escapeHtml, type Keyboard } from '../../core/format.ts';
import { ack, btn, show, type BotContext } from '../ui.ts';

const TZ_PRESETS: Array<[string, string]> = [
  ['Калининград', 'Europe/Kaliningrad'],
  ['Москва', 'Europe/Moscow'],
  ['Самара', 'Europe/Samara'],
  ['Екатеринбург', 'Asia/Yekaterinburg'],
  ['Омск', 'Asia/Omsk'],
  ['Новосибирск', 'Asia/Novosibirsk'],
  ['Иркутск', 'Asia/Irkutsk'],
  ['Владивосток', 'Asia/Vladivostok'],
];

const CAP_PRESETS = [5, 10, 20, 50];

/** «UTC+3», «+3», «GMT-5», «Europe/Berlin» → IANA-пояс или null. */
export function parseTimeZone(input: string): string | null {
  const s = input.trim();
  const m = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})$/i.exec(s);
  if (m) {
    const h = Number(m[2]);
    if (h > 14) return null;
    if (h === 0) return 'Etc/UTC';
    // в Etc/GMT знак инвертирован: UTC+3 = Etc/GMT-3
    return `Etc/GMT${m[1] === '+' ? '-' : '+'}${h}`;
  }
  if (/^(utc|gmt)$/i.test(s)) return 'Etc/UTC';
  if (/^[A-Za-z_]+(?:\/[A-Za-z_+-]+){1,2}$/.test(s) && isValidTimeZone(s)) return s;
  return null;
}

function settingsScreen(ctx: BotContext): { text: string; keyboard: Keyboard } {
  const u = ctx.user;
  const local = localParts(ctx.svc.now(), u.tz);
  const quiet = u.quietFrom && u.quietTo ? `${u.quietFrom}–${u.quietTo}` : 'выключены';
  const text =
    '⚙️ <b>Настройки</b>\n\n' +
    `🕐 Часовой пояс: <b>${escapeHtml(u.tz)}</b> (сейчас ${local.time})\n` +
    `🌙 Тихие часы: <b>${quiet}</b> — уведомления копятся и приходят одним дайджестом после; ` +
    'очень выгодные (ниже порога на 30%+) приходят сразу, но без звука.\n' +
    `🔔 Лимит уведомлений в день: <b>${u.dailyAlertCap}</b>`;
  const keyboard: Keyboard = [
    [btn('🕐 Часовой пояс', 's:tz')],
    [btn('🌙 Тихие часы', 's:q'), ...(u.quietFrom ? [btn('Выключить', 's:qoff')] : [])],
    [btn('🔔 Лимит в день', 's:cap')],
  ];
  return { text, keyboard };
}

export async function cmdSettings(ctx: BotContext, edit = false): Promise<void> {
  const { text, keyboard } = settingsScreen(ctx);
  await show(ctx, text, keyboard, { edit });
}

async function reload(ctx: BotContext): Promise<void> {
  const fresh = await ctx.svc.repo.getUserById(ctx.user.id);
  if (fresh) ctx.user = fresh;
}

export async function handleSettingsCallback(ctx: BotContext, data: string): Promise<void> {
  const { svc, user } = ctx;
  const [, action, ...rest] = data.split(':');
  const arg = rest.join(':');
  const nowIso = svc.now().toISOString();
  await ack(ctx);
  switch (action) {
    case 'tz':
      if (arg) {
        if (!isValidTimeZone(arg)) return;
        await svc.repo.updateUserSettings(user.id, { tz: arg }, nowIso);
        await svc.repo.clearWizard(user.tgUserId);
        await reload(ctx);
        return cmdSettings(ctx, true);
      }
      await svc.repo.setWizard(user.tgUserId, 'settings:tz', '{}', nowIso);
      return show(
        ctx,
        'Выбери часовой пояс или напиши свой: <code>Europe/Berlin</code>, <code>UTC+5</code>.',
        [
          ...[0, 2, 4, 6].map((i) => TZ_PRESETS.slice(i, i + 2).map(([label, tz]) => btn(label, `s:tz:${tz}`))),
          [btn('← Назад', 's:back')],
        ],
        { edit: true },
      );
    case 'q':
      await svc.repo.setWizard(user.tgUserId, 'settings:quiet', '{}', nowIso);
      return show(ctx, 'Напиши тихие часы в формате <code>23:00-08:00</code> (твоё местное время).', [[btn('Выключить', 's:qoff'), btn('← Назад', 's:back')]], { edit: true });
    case 'qoff':
      await svc.repo.updateUserSettings(user.id, { quietFrom: null, quietTo: null }, nowIso);
      await svc.repo.clearWizard(user.tgUserId);
      await reload(ctx);
      return cmdSettings(ctx, true);
    case 'cap':
      if (arg) {
        const n = Number(arg);
        if (!CAP_PRESETS.includes(n)) return;
        await svc.repo.updateUserSettings(user.id, { dailyAlertCap: n }, nowIso);
        await reload(ctx);
        return cmdSettings(ctx, true);
      }
      return show(ctx, 'Сколько уведомлений в день максимум?', [CAP_PRESETS.map((n) => btn(String(n), `s:cap:${n}`)), [btn('← Назад', 's:back')]], { edit: true });
    case 'back':
      await svc.repo.clearWizard(user.tgUserId);
      return cmdSettings(ctx, true);
  }
}

/** Текстовый ввод в режиме настроек; true — обработано. */
export async function handleSettingsText(ctx: BotContext, text: string): Promise<boolean> {
  const { svc, user } = ctx;
  const st = await svc.repo.getWizard(user.tgUserId);
  if (!st || !st.step.startsWith('settings:')) return false;
  if (svc.now().getTime() - Date.parse(st.updatedAt) > BOT.WIZARD_TTL_MIN * 60_000) {
    await svc.repo.clearWizard(user.tgUserId);
    return false;
  }
  const nowIso = svc.now().toISOString();
  if (st.step === 'settings:tz') {
    const tz = parseTimeZone(text);
    if (!tz) {
      await ctx.reply('Не понял пояс. Примеры: Europe/Berlin, Asia/Almaty, UTC+5.');
      return true;
    }
    await svc.repo.updateUserSettings(user.id, { tz }, nowIso);
  } else if (st.step === 'settings:quiet') {
    const r = parseTimeWindow(text);
    if (!r.ok) {
      await ctx.reply(`⚠️ ${r.error}`);
      return true;
    }
    await svc.repo.updateUserSettings(user.id, { quietFrom: r.value?.from ?? null, quietTo: r.value?.to ?? null }, nowIso);
  } else {
    return false;
  }
  await svc.repo.clearWizard(user.tgUserId);
  await reload(ctx);
  await cmdSettings(ctx);
  return true;
}
