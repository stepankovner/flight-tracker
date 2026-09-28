import { describe, expect, it } from 'vitest';
import { calendarKey, effectiveWindow, estimateResponseBytes, planBootstrap, planQueries, queryKey } from '../../src/core/queryPlanner.ts';
import type { FareQuery } from '../../src/core/types.ts';
import { spec } from '../helpers.ts';

const TODAY = '2026-09-28';
const OPTS = { currency: 'RUB', market: 'ru' };

function plan(over: Parameters<typeof spec>[0], today = TODAY): FareQuery[] {
  const r = planQueries(spec(over), today, OPTS);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const legs = (qs: FareQuery[]) => qs.map((q) => `${q.origin}-${q.destination} ${q.departureAt}${q.returnAt ? `/${q.returnAt}` : ''}`);

describe('planQueries: oneway', () => {
  it('одно окно в пределах месяца → 1 запрос на месяц', () => {
    const qs = plan({ tripType: 'oneway' });
    expect(legs(qs)).toEqual(['MOW-IST 2026-11']);
    expect(qs[0]).toMatchObject({ oneWay: true, direct: false, returnAt: null, currency: 'rub', market: 'ru' });
  });

  it('окно через границу месяцев → запрос на каждый месяц', () => {
    expect(legs(plan({ tripType: 'oneway', departFrom: '2026-11-25', departTo: '2027-01-05' }))).toEqual([
      'MOW-IST 2026-11',
      'MOW-IST 2026-12',
      'MOW-IST 2027-01',
    ]);
  });

  it('короткое окно: дни, если их не больше, чем месяцев', () => {
    expect(legs(plan({ tripType: 'oneway', departFrom: '2026-11-15', departTo: '2026-11-15' }))).toEqual(['MOW-IST 2026-11-15']);
    expect(legs(plan({ tripType: 'oneway', departFrom: '2026-11-30', departTo: '2026-12-01' }))).toEqual([
      'MOW-IST 2026-11-30',
      'MOW-IST 2026-12-01',
    ]);
    // 3 дня в одном месяце: месяц выгоднее
    expect(legs(plan({ tripType: 'oneway', departFrom: '2026-11-14', departTo: '2026-11-16' }))).toEqual(['MOW-IST 2026-11']);
  });

  it('только прямые передаются в запрос', () => {
    expect(plan({ tripType: 'oneway', directOnly: true })[0]!.direct).toBe(true);
  });

  it('прошедшая часть окна отбрасывается', () => {
    expect(legs(plan({ tripType: 'oneway', departFrom: '2026-08-01', departTo: '2026-10-15' }))).toEqual([
      'MOW-IST 2026-09',
      'MOW-IST 2026-10',
    ]);
  });
});

describe('planQueries: roundtrip', () => {
  it('месяц вылета × достижимые месяцы возврата', () => {
    // вылет 15–30 ноября, 6–9 ночей → возврат 21 ноя – 9 дек
    expect(legs(plan({}))).toEqual(['MOW-IST 2026-11/2026-11', 'MOW-IST 2026-11/2026-12']);
  });

  it('учитывает «вернуться не позже»', () => {
    expect(legs(plan({ returnTo: '2026-11-30' }))).toEqual(['MOW-IST 2026-11/2026-11']);
  });

  it('несколько месяцев вылета — только реально достижимые пары', () => {
    expect(legs(plan({ departFrom: '2026-11-15', departTo: '2026-12-10', nightsMin: 7, nightsMax: 9 }))).toEqual([
      'MOW-IST 2026-11/2026-11',
      'MOW-IST 2026-11/2026-12',
      'MOW-IST 2026-12/2026-12',
    ]);
  });

  it('короткое окно и точные ночи → конкретные даты', () => {
    expect(legs(plan({ departFrom: '2026-11-15', departTo: '2026-11-15', nightsMin: 7, nightsMax: 7 }))).toEqual([
      'MOW-IST 2026-11-15/2026-11-22',
    ]);
  });

  it('короткое окно с широкими ночами → месяцы (меньше запросов)', () => {
    expect(legs(plan({ departFrom: '2026-11-10', departTo: '2026-11-12', nightsMin: 5, nightsMax: 9 }))).toEqual([
      'MOW-IST 2026-11/2026-11',
    ]);
  });

  it('короткое окно на стыке месяцев → день × месяц возврата', () => {
    // дни×дни = 10, день×месяц = 2, месяц×месяц = 2 → при равенстве берём более точный
    expect(legs(plan({ departFrom: '2026-11-30', departTo: '2026-12-01', nightsMin: 5, nightsMax: 9 }))).toEqual([
      'MOW-IST 2026-11-30/2026-12',
      'MOW-IST 2026-12-01/2026-12',
    ]);
    // возврат целиком в одном месяце: месяц×месяц = 1 — выгоднее
    expect(legs(plan({ departFrom: '2026-11-29', departTo: '2026-11-30', nightsMin: 3, nightsMax: 5 }))).toEqual(['MOW-IST 2026-11/2026-12']);
  });

  it('без ночей — ошибка', () => {
    const r = planQueries(spec({ nightsMin: null, nightsMax: null }), TODAY, OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid');
  });

  it('невозможная дата возврата — ошибка', () => {
    const r = planQueries(spec({ returnTo: '2026-11-16' }), TODAY, OPTS);
    expect(!r.ok && r.error.code).toBe('no_return_dates');
  });
});

describe('planQueries: города и лимиты', () => {
  it('декартово произведение городов без совпадающих пар', () => {
    const qs = plan({ tripType: 'oneway', origins: ['MOW', 'LED'], destinations: ['IST', 'LED'] });
    expect(legs(qs)).toEqual(['MOW-IST 2026-11', 'MOW-LED 2026-11', 'LED-IST 2026-11']);
  });

  it('больше 24 запросов → отказ с объяснением', () => {
    const r = planQueries(
      spec({ tripType: 'oneway', origins: ['MOW', 'LED', 'KZN'], destinations: ['IST', 'AYT', 'DXB'], departFrom: '2026-10-01', departTo: '2026-12-31' }),
      TODAY,
      OPTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('too_many_queries');
      expect(r.error.queries).toBe(27);
      expect(r.error.message).toMatch(/Сузь даты/);
    }
  });

  it('слишком «тяжёлое» туда-обратно (много помесячных пар) → отказ', () => {
    // 2 направления × 4 пары месяцев × 150 КБ = 1,2 МБ > 900 КБ
    const r = planQueries(spec({ destinations: ['IST', 'AYT'], departFrom: '2026-10-01', departTo: '2026-11-30' }), TODAY, OPTS);
    expect(!r.ok && r.error.code).toBe('too_heavy');
    if (!r.ok) expect(r.error.message).toMatch(/раздели на два наблюдения/);
    // то же в одну сторону — лёгкое
    expect(planQueries(spec({ tripType: 'oneway', destinations: ['IST', 'AYT'], departFrom: '2026-10-01', departTo: '2026-11-30' }), TODAY, OPTS).ok).toBe(true);
    expect(estimateResponseBytes({ oneWay: false, departureAt: '2026-11-15', returnAt: '2026-11-22' })).toBe(50_000);
  });

  it('ровно 24 запроса допустимы', () => {
    const qs = plan({ tripType: 'oneway', origins: ['MOW', 'LED'], destinations: ['IST', 'AYT', 'DXB'], departFrom: '2026-10-01', departTo: '2027-01-31' });
    expect(qs).toHaveLength(24);
  });

  it('совпадающие пункты → ошибка', () => {
    const r = planQueries(spec({ origins: ['MOW'], destinations: ['MOW'] }), TODAY, OPTS);
    expect(!r.ok && r.error.code).toBe('no_pairs');
  });

  it('прошедшее окно → ошибка window_passed', () => {
    const r = planQueries(spec({ departFrom: '2026-09-01', departTo: '2026-09-20' }), TODAY, OPTS);
    expect(!r.ok && r.error.code).toBe('window_passed');
    expect(effectiveWindow({ departFrom: '2026-09-01', departTo: '2026-09-20' }, TODAY)).toBeNull();
  });
});

describe('queryKey', () => {
  it('одинаковые запросы разных watch дают один ключ', () => {
    const a = plan({ maxPrice: 5000 });
    const b = plan({ maxPrice: 9000, priceMode: 'auto', departWeekdays: [5] });
    expect(a.map(queryKey)).toEqual(b.map(queryKey));
    expect(queryKey(a[0]!)).toBe('pfd|MOW|IST|2026-11|2026-11|rt|a|rub|ru');
  });

  it('разные параметры — разные ключи', () => {
    const [a] = plan({ tripType: 'oneway' });
    const [b] = plan({ tripType: 'oneway', directOnly: true });
    expect(queryKey(a!)).not.toBe(queryKey(b!));
  });
});

describe('planBootstrap', () => {
  it('месяцы окна, затем соседние; в пределах лимита', () => {
    const qs = planBootstrap(spec({}), TODAY, { ...OPTS, neighborMonths: 1, maxQueries: 6 });
    expect(qs.map((q) => q.month)).toEqual(['2026-11', '2026-10', '2026-12']);
    expect(qs[0]).toMatchObject({ oneWay: false, minTripDuration: 6, maxTripDuration: 9 });
    const limited = planBootstrap(spec({ origins: ['MOW', 'LED'] }), TODAY, { ...OPTS, neighborMonths: 1, maxQueries: 3 });
    expect(limited).toHaveLength(3);
    expect(calendarKey(limited[0]!)).toBe('grp|MOW|IST|2026-11|rt|a|6|9|rub|ru');
  });

  it('не уходит в прошлые месяцы', () => {
    const qs = planBootstrap(spec({ tripType: 'oneway', departFrom: '2026-09-28', departTo: '2026-09-30' }), TODAY, { ...OPTS, neighborMonths: 1, maxQueries: 6 });
    expect(qs.map((q) => q.month)).toEqual(['2026-09', '2026-10']);
    expect(qs[0]!.minTripDuration).toBeNull();
  });

  it('пустой план для прошедшего окна', () => {
    expect(planBootstrap(spec({ departFrom: '2026-01-01', departTo: '2026-01-10' }), TODAY, { ...OPTS, neighborMonths: 1, maxQueries: 6 })).toEqual([]);
  });
});
