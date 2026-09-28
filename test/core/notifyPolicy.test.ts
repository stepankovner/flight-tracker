import { describe, expect, it } from 'vitest';
import {
  canSendDigest,
  decideAlertDelivery,
  isQuietTime,
  isStale,
  isUrgent,
  minAbsDrop,
  shouldNotify,
  systemSilent,
  userDayStart,
} from '../../src/core/notifyPolicy.ts';

const msk = { tz: 'Europe/Moscow', quietFrom: '23:00', quietTo: '08:00', dailyAlertCap: 3 };

describe('shouldNotify (повторы)', () => {
  it('новый оффер — да; заглушённый — никогда', () => {
    expect(shouldNotify(undefined, 9000, 'rub')).toBe(true);
    expect(shouldNotify({ lastPrice: 20000, muted: true }, 1000, 'rub')).toBe(false);
  });

  it('повтор только при падении на ≥ 5% и ≥ 300 ₽', () => {
    const prev = { lastPrice: 10000, muted: false };
    expect(shouldNotify(prev, 10000, 'rub')).toBe(false);
    expect(shouldNotify(prev, 9600, 'rub')).toBe(false); // 4%
    expect(shouldNotify(prev, 9500, 'rub')).toBe(true); // 5% и 500 ₽
    expect(shouldNotify(prev, 11000, 'rub')).toBe(false);
    // 5%, но всего 200 ₽
    expect(shouldNotify({ lastPrice: 4000, muted: false }, 3800, 'rub')).toBe(false);
    expect(shouldNotify({ lastPrice: 4000, muted: false }, 3700, 'rub')).toBe(true);
  });

  it('абсолютный порог зависит от валюты', () => {
    expect(minAbsDrop('RUB')).toBe(300);
    expect(minAbsDrop('usd')).toBe(4);
    expect(minAbsDrop('xyz')).toBe(300);
    expect(shouldNotify({ lastPrice: 100, muted: false }, 95, 'usd')).toBe(true);
  });
});

describe('isQuietTime (часовой пояс пользователя)', () => {
  it('окно через полночь', () => {
    expect(isQuietTime(new Date('2026-09-28T21:00:00Z'), msk)).toBe(true); // 00:00 МСК
    expect(isQuietTime(new Date('2026-09-28T20:00:00Z'), msk)).toBe(true); // 23:00 МСК
    expect(isQuietTime(new Date('2026-09-28T19:59:00Z'), msk)).toBe(false); // 22:59
    expect(isQuietTime(new Date('2026-09-28T04:59:00Z'), msk)).toBe(true); // 07:59
    expect(isQuietTime(new Date('2026-09-28T05:00:00Z'), msk)).toBe(false); // 08:00
    expect(isQuietTime(new Date('2026-09-28T09:00:00Z'), msk)).toBe(false); // 12:00
  });

  it('другой пояс: Новосибирск (UTC+7)', () => {
    const nsk = { ...msk, tz: 'Asia/Novosibirsk' };
    expect(isQuietTime(new Date('2026-09-28T17:00:00Z'), nsk)).toBe(true); // 00:00 НСК
    expect(isQuietTime(new Date('2026-09-28T17:00:00Z'), msk)).toBe(false); // 20:00 МСК
  });

  it('дневное окно и выключенные тихие часы', () => {
    const day = { tz: 'Europe/Moscow', quietFrom: '13:00', quietTo: '15:00' };
    expect(isQuietTime(new Date('2026-09-28T10:30:00Z'), day)).toBe(true);
    expect(isQuietTime(new Date('2026-09-28T12:30:00Z'), day)).toBe(false);
    expect(isQuietTime(new Date('2026-09-28T21:00:00Z'), { tz: 'Europe/Moscow', quietFrom: null, quietTo: null })).toBe(false);
    expect(isQuietTime(new Date(), { tz: 'Europe/Moscow', quietFrom: '10:00', quietTo: '10:00' })).toBe(false);
  });
});

describe('decideAlertDelivery', () => {
  const day = new Date('2026-09-28T09:00:00Z'); // 12:00 МСК
  const night = new Date('2026-09-28T22:00:00Z'); // 01:00 МСК

  it('днём и в пределах лимита — отправить', () => {
    expect(decideAlertDelivery(false, { now: day, user: msk, sentToday: 0 })).toEqual({ action: 'send', silent: false });
  });

  it('лимит исчерпан — отложить в дайджест', () => {
    expect(decideAlertDelivery(false, { now: day, user: msk, sentToday: 3 })).toEqual({ action: 'defer', reason: 'cap' });
    expect(decideAlertDelivery(true, { now: night, user: msk, sentToday: 3 })).toEqual({ action: 'defer', reason: 'cap' });
  });

  it('тихие часы: обычное — отложить, очень выгодное — без звука', () => {
    expect(decideAlertDelivery(false, { now: night, user: msk, sentToday: 0 })).toEqual({ action: 'defer', reason: 'quiet' });
    expect(decideAlertDelivery(true, { now: night, user: msk, sentToday: 0 })).toEqual({ action: 'send', silent: true });
  });

  it('дайджест — вне тихих часов и в пределах лимита', () => {
    expect(canSendDigest({ now: day, user: msk, sentToday: 0 })).toBe(true);
    expect(canSendDigest({ now: night, user: msk, sentToday: 0 })).toBe(false);
    expect(canSendDigest({ now: day, user: msk, sentToday: 3 })).toBe(false);
    expect(systemSilent(night, msk)).toBe(true);
  });
});

describe('прочее', () => {
  it('начало суток пользователя в UTC', () => {
    // 01:30 МСК 29 сентября → сутки начались 28.09 в 21:00 UTC
    expect(userDayStart(new Date('2026-09-28T22:30:00Z'), 'Europe/Moscow').toISOString()).toBe('2026-09-28T21:00:00.000Z');
    expect(userDayStart(new Date('2026-09-28T20:30:00Z'), 'Europe/Moscow').toISOString()).toBe('2026-09-27T21:00:00.000Z');
    expect(userDayStart(new Date('2026-09-28T12:00:00Z'), 'Asia/Vladivostok').toISOString()).toBe('2026-09-27T14:00:00.000Z'); // 22:00 во Владивостоке
  });

  it('isUrgent: ниже max_price на ≥ 30%', () => {
    expect(isUrgent(7000, 10000)).toBe(true);
    expect(isUrgent(7001, 10000)).toBe(false);
    expect(isUrgent(1000, null)).toBe(false);
  });

  it('isStale: дольше 36 ч', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    expect(isStale('2026-09-27T01:00:00Z', now)).toBe(false);
    expect(isStale('2026-09-26T23:00:00Z', now)).toBe(true);
  });
});
