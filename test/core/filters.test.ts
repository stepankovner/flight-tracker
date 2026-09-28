import { describe, expect, it } from 'vitest';
import { inTimeWindow, localTimeOf, nightsOf, offerKey, rejectReason, selectMatching } from '../../src/core/filters.ts';
import { offer, spec } from '../helpers.ts';

const NOW = new Date('2026-09-28T12:00:00Z');

describe('rejectReason', () => {
  it('подходящий оффер', () => {
    expect(rejectReason(offer(), spec(), NOW)).toBeNull();
  });

  it('окно вылета', () => {
    expect(rejectReason(offer({ departAt: '2026-11-14T23:00:00+03:00' }), spec(), NOW)).toBe('depart_window');
    expect(rejectReason(offer({ departAt: '2026-12-01T01:00:00+03:00', returnAt: '2026-12-08T01:00:00+03:00' }), spec(), NOW)).toBe('depart_window');
  });

  it('дата берётся локальная, без пересчёта в UTC', () => {
    // 00:30 по Москве 15 ноября = 21:30 UTC 14 ноября — всё равно 15-е
    expect(rejectReason(offer({ departAt: '2026-11-15T00:30:00+03:00', returnAt: '2026-11-21T10:00:00+03:00' }), spec(), NOW)).toBeNull();
  });

  it('ночи: граница диапазона включительно', () => {
    expect(rejectReason(offer({ returnAt: '2026-11-24T10:00:00+03:00' }), spec(), NOW)).toBeNull(); // 6
    expect(rejectReason(offer({ returnAt: '2026-11-27T10:00:00+03:00' }), spec(), NOW)).toBeNull(); // 9
    expect(rejectReason(offer({ returnAt: '2026-11-23T10:00:00+03:00' }), spec(), NOW)).toBe('nights'); // 5
    expect(rejectReason(offer({ returnAt: '2026-11-28T10:00:00+03:00' }), spec(), NOW)).toBe('nights'); // 10
    expect(nightsOf(offer())).toBe(7);
  });

  it('тип поездки', () => {
    expect(rejectReason(offer({ returnAt: null }), spec(), NOW)).toBe('trip_type');
    expect(rejectReason(offer(), spec({ tripType: 'oneway', nightsMin: null, nightsMax: null }), NOW)).toBe('trip_type');
    expect(rejectReason(offer({ returnAt: null, transfersBack: null }), spec({ tripType: 'oneway' }), NOW)).toBeNull();
  });

  it('вернуться не позже', () => {
    expect(rejectReason(offer(), spec({ returnTo: '2026-11-24' }), NOW)).toBe('return_to');
    expect(rejectReason(offer(), spec({ returnTo: '2026-11-25' }), NOW)).toBeNull();
  });

  it('дни недели вылета и возврата', () => {
    // 18.11.2026 — среда (3), 25.11.2026 — среда
    expect(rejectReason(offer(), spec({ departWeekdays: [3] }), NOW)).toBeNull();
    expect(rejectReason(offer(), spec({ departWeekdays: [5, 6] }), NOW)).toBe('depart_weekday');
    expect(rejectReason(offer(), spec({ returnWeekdays: [7] }), NOW)).toBe('return_weekday');
    expect(rejectReason(offer(), spec({ returnWeekdays: [3] }), NOW)).toBeNull();
  });

  it('пересадки — и туда, и обратно', () => {
    expect(rejectReason(offer({ transfersOut: 1, transfersBack: 0 }), spec({ maxTransfers: 1 }), NOW)).toBeNull();
    expect(rejectReason(offer({ transfersOut: 0, transfersBack: 2 }), spec({ maxTransfers: 1 }), NOW)).toBe('transfers');
    expect(rejectReason(offer({ transfersOut: 0, transfersBack: 1 }), spec({ directOnly: true }), NOW)).toBe('transfers');
    expect(rejectReason(offer({ transfersOut: 0, transfersBack: 0 }), spec({ directOnly: true }), NOW)).toBeNull();
    expect(rejectReason(offer({ transfersOut: 2 }), spec({ directOnly: false, maxTransfers: null }), NOW)).toBeNull();
  });

  it('длительность каждого направления', () => {
    expect(rejectReason(offer({ durationOutMin: 360, durationBackMin: 240 }), spec({ maxDurationMin: 360 }), NOW)).toBeNull();
    expect(rejectReason(offer({ durationOutMin: 400 }), spec({ maxDurationMin: 360 }), NOW)).toBe('duration');
    expect(
      rejectReason(offer({ returnAt: null, transfersBack: null, durationOutMin: null, durationBackMin: null, durationMin: 500 }), spec({ tripType: 'oneway', maxDurationMin: 360 }), NOW),
    ).toBe('duration');
  });

  it('исключённые авиакомпании', () => {
    expect(rejectReason(offer({ airline: 'PC' }), spec({ excludeAirlines: ['PC'] }), NOW)).toBe('airline');
    expect(rejectReason(offer({ airline: 'SU' }), spec({ excludeAirlines: ['PC'] }), NOW)).toBeNull();
  });

  it('время вылета (локальное), в т.ч. окно через полночь', () => {
    expect(rejectReason(offer(), spec({ departTimeFrom: '06:00', departTimeTo: '23:00' }), NOW)).toBeNull();
    expect(rejectReason(offer({ departAt: '2026-11-18T02:15:00+03:00' }), spec({ departTimeFrom: '06:00', departTimeTo: '23:00' }), NOW)).toBe('depart_time');
    expect(inTimeWindow('23:30', '22:00', '02:00')).toBe(true);
    expect(inTimeWindow('01:59', '22:00', '02:00')).toBe(true);
    expect(inTimeWindow('12:00', '22:00', '02:00')).toBe(false);
    expect(inTimeWindow('12:00', '10:00', null)).toBe(true);
    expect(inTimeWindow('09:00', null, '08:00')).toBe(false);
    expect(localTimeOf('2026-11-18T06:40:00+03:00')).toBe('06:40');
  });

  it('не в прошлом и не раньше чем через 3 часа', () => {
    const now = new Date('2026-11-18T01:00:00Z'); // 04:00 МСК, вылет в 06:40 МСК — через 2 ч 40 мин
    expect(rejectReason(offer(), spec(), now)).toBe('too_soon');
    expect(rejectReason(offer(), spec(), new Date('2026-11-18T00:30:00Z'))).toBeNull();
    expect(rejectReason(offer(), spec(), new Date('2026-12-01T00:00:00Z'))).toBe('too_soon');
  });

  it('просроченная цена и мусорные данные', () => {
    expect(rejectReason(offer({ expiresAt: '2026-09-28T11:00:00Z' }), spec(), NOW)).toBe('expired');
    expect(rejectReason(offer({ expiresAt: '2026-09-29T11:00:00Z' }), spec(), NOW)).toBeNull();
    expect(rejectReason(offer({ departAt: 'garbage' }), spec(), NOW)).toBe('bad_data');
    expect(rejectReason(offer({ price: 0 }), spec(), NOW)).toBe('bad_data');
    expect(rejectReason(offer({ returnAt: '2026-11-10T10:00:00+03:00' }), spec(), NOW)).toBe('bad_data');
  });
});

describe('selectMatching / offerKey', () => {
  it('фильтрует, убирает дубли (оставляя дешёвый) и сортирует по цене', () => {
    const a = offer({ price: 9000 });
    const aCheaper = offer({ price: 8000 });
    const b = offer({ price: 7000, airline: 'SU', flightNumber: '100' });
    const bad = offer({ price: 100, returnAt: null });
    const res = selectMatching([a, b, bad, aCheaper], spec(), NOW);
    expect(res.map((o) => o.price)).toEqual([7000, 8000]);
  });

  it('формат offer_key', () => {
    expect(offerKey(offer())).toBe('SVO|IST|2026-11-18|2026-11-25|PC|395');
    expect(offerKey(offer({ returnAt: null }))).toBe('SVO|IST|2026-11-18||PC|395');
  });
});
