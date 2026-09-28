import { NOTIFY } from '../config.ts';
import { localParts, parseHm, todayIn, zonedDayStart } from './dates.ts';
import type { User } from './types.ts';

export { offerKey } from './filters.ts';

export interface NotifiedState {
  lastPrice: number;
  muted: boolean;
}

/** Минимальное абсолютное падение цены для повторного уведомления в валюте пользователя. */
export function minAbsDrop(currency: string): number {
  return NOTIFY.REALERT_MIN_DROP_ABS_BY_CURRENCY[currency.toLowerCase()] ?? NOTIFY.REALERT_MIN_DROP_ABS;
}

/**
 * Можно ли уведомлять об оффере. Повтор — только если цена упала на ≥ 5% и ≥ 300 ₽
 * относительно последней отправленной. Заглушённые («Не показывать этот рейс») — никогда.
 */
export function shouldNotify(prev: NotifiedState | undefined, price: number, currency: string): boolean {
  if (!prev) return true;
  if (prev.muted) return false;
  const drop = prev.lastPrice - price;
  return drop >= minAbsDrop(currency) && drop >= prev.lastPrice * NOTIFY.REALERT_MIN_DROP_PCT;
}

type QuietSettings = Pick<User, 'tz' | 'quietFrom' | 'quietTo'>;

/** Сейчас тихие часы у пользователя? Поддерживает окна через полночь (23:00–08:00). */
export function isQuietTime(now: Date, user: QuietSettings): boolean {
  if (!user.quietFrom || !user.quietTo) return false;
  const from = parseHm(user.quietFrom);
  const to = parseHm(user.quietTo);
  if (from === null || to === null || from === to) return false;
  const t = localParts(now, user.tz).minutes;
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** Начало «сегодня» пользователя в UTC — для подсчёта дневного лимита. */
export function userDayStart(now: Date, tz: string): Date {
  return zonedDayStart(todayIn(now, tz), tz);
}

/** Уведомление настолько выгодное, что его стоит прислать и в тихие часы (без звука). */
export function isUrgent(price: number, maxPrice: number | null): boolean {
  return maxPrice !== null && maxPrice > 0 && price <= maxPrice * (1 - NOTIFY.URGENT_BELOW_MAX_PCT);
}

export type Delivery =
  | { action: 'send'; silent: boolean }
  | { action: 'defer'; reason: 'quiet' | 'cap' };

export interface DeliveryContext {
  now: Date;
  user: QuietSettings & Pick<User, 'dailyAlertCap'>;
  /** Сколько уведомлений (alert/digest) уже ушло пользователю за его сегодня. */
  sentToday: number;
}

/** Решение по одному уведомлению о дешёвой цене. */
export function decideAlertDelivery(urgent: boolean, ctx: DeliveryContext): Delivery {
  if (ctx.sentToday >= ctx.user.dailyAlertCap) return { action: 'defer', reason: 'cap' };
  if (isQuietTime(ctx.now, ctx.user)) {
    return urgent ? { action: 'send', silent: true } : { action: 'defer', reason: 'quiet' };
  }
  return { action: 'send', silent: false };
}

/** Можно ли сейчас отправить дайджест отложенных уведомлений. */
export function canSendDigest(ctx: DeliveryContext): boolean {
  return !isQuietTime(ctx.now, ctx.user) && ctx.sentToday < ctx.user.dailyAlertCap;
}

/** Отложенное уведомление устарело (цены из кэша, смысла слать нет). */
export function isStale(createdAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(createdAt) > NOTIFY.DIGEST_MAX_AGE_HOURS * 3_600_000;
}

/** Системные сообщения и ответы на действия пользователя: в тихие часы — без звука, лимит не действует. */
export function systemSilent(now: Date, user: QuietSettings): boolean {
  return isQuietTime(now, user);
}
