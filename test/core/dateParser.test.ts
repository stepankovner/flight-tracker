import { describe, expect, it } from 'vitest';
import { monthFromWord, parseDateRange, parseNights, parsePrice, parseTimeWindow } from '../../src/core/dateParser.ts';

const TODAY = '2026-09-28';

function range(input: string, today = TODAY) {
  const r = parseDateRange(input, today);
  if (!r.ok) throw new Error(`expected ok for "${input}", got: ${r.error}`);
  return r.value;
}

function fails(input: string, today = TODAY) {
  const r = parseDateRange(input, today);
  expect(r.ok, `expected error for "${input}"`).toBe(false);
  return r.ok ? '' : r.error;
}

describe('parseDateRange', () => {
  it.each([
    ['15.11-30.11', '2026-11-15', '2026-11-30'],
    ['15.11 - 30.11', '2026-11-15', '2026-11-30'],
    ['15.11–30.11', '2026-11-15', '2026-11-30'],
    ['с 15.11 по 30.11', '2026-11-15', '2026-11-30'],
    ['15/11-30/11', '2026-11-15', '2026-11-30'],
    ['15.11.2026-02.12.2026', '2026-11-15', '2026-12-02'],
    ['15.11.26-02.12.26', '2026-11-15', '2026-12-02'],
    ['15-30.11', '2026-11-15', '2026-11-30'],
    ['15-30 ноября', '2026-11-15', '2026-11-30'],
    ['15 ноября - 2 декабря', '2026-11-15', '2026-12-02'],
    ['ноябрь', '2026-11-01', '2026-11-30'],
    ['Ноябрь', '2026-11-01', '2026-11-30'],
    ['в ноябре', '2026-11-01', '2026-11-30'],
    ['нояб', '2026-11-01', '2026-11-30'],
    ['november', '2026-11-01', '2026-11-30'],
    ['ноябрь-декабрь', '2026-11-01', '2026-12-31'],
    ['ноябрь 2026', '2026-11-01', '2026-11-30'],
    ['15.11', '2026-11-15', '2026-11-15'],
    ['±3 от 20.11', '2026-11-17', '2026-11-23'],
    ['+-3 от 20.11', '2026-11-17', '2026-11-23'],
    ['± 3 дня от 20.11', '2026-11-17', '2026-11-23'],
    ['20.11 ±3', '2026-11-17', '2026-11-23'],
    ['2026-11-15', '2026-11-15', '2026-11-15'],
    ['2026-11-15..2026-11-20', '2026-11-15', '2026-11-20'],
    ['май', '2027-05-01', '2027-05-31'],
    ['март', '2027-03-01', '2027-03-31'],
  ])('%s → %s..%s', (input, from, to) => {
    const r = range(input);
    expect(r.from).toBe(from);
    expect(r.to).toBe(to);
  });

  it('подставляет следующий год для прошедших дат и месяцев', () => {
    expect(range('10.01')).toMatchObject({ from: '2027-01-10', to: '2027-01-10' });
    expect(range('август')).toMatchObject({ from: '2027-08-01', to: '2027-08-31' });
    expect(range('15.08-20.08')).toMatchObject({ from: '2027-08-15', to: '2027-08-20' });
  });

  it('обрабатывает переход через Новый год', () => {
    const today = '2026-12-20';
    expect(range('25.12-10.01', today)).toMatchObject({ from: '2026-12-25', to: '2027-01-10' });
    expect(range('январь', today)).toMatchObject({ from: '2027-01-01', to: '2027-01-31' });
    expect(range('декабрь-январь', today)).toMatchObject({ from: '2026-12-20', to: '2027-01-31', clamped: true });
    expect(range('ноябрь-январь', '2026-09-28')).toMatchObject({ from: '2026-11-01', to: '2027-01-31' });
    expect(range('05.01', today)).toMatchObject({ from: '2027-01-05' });
    expect(range('±5 от 02.01', today)).toMatchObject({ from: '2026-12-28', to: '2027-01-07' });
  });

  it('сдвигает начало окна на сегодня, если оно в прошлом', () => {
    expect(range('сентябрь')).toEqual({ from: '2026-09-28', to: '2026-09-30', clamped: true });
    expect(range('20.09-05.10')).toEqual({ from: '2026-09-28', to: '2026-10-05', clamped: true });
    expect(range('±3 от 29.09')).toEqual({ from: '2026-09-28', to: '2026-10-02', clamped: true });
  });

  it('обрезает конец окна по горизонту данных', () => {
    expect(range('сентябрь 2027')).toEqual({ from: '2027-09-01', to: '2027-09-29', clamped: false, truncated: true });
  });

  it('отклоняет некорректный ввод', () => {
    fails('завтра');
    fails('');
    fails('31.02');
    fails('32.11');
    fails('15.13');
    fails('01.01.2025-10.01.2025');
    expect(fails('01.01.2028')).toMatch(/далеко/);
    expect(fails('ноябрь 2027')).toMatch(/далеко/);
    fails('30.11.2026-15.11.2026');
    expect(fails('±40 от 20.11')).toMatch(/разброс/);
    fails('ноябрь-foo');
    fails('2026-02-30');
  });
});

describe('monthFromWord', () => {
  it('различает март и май', () => {
    expect(monthFromWord('марта')).toBe(3);
    expect(monthFromWord('мая')).toBe(5);
    expect(monthFromWord('мае')).toBe(5);
    expect(monthFromWord('май')).toBe(5);
    expect(monthFromWord('маяк')).toBeNull();
    expect(monthFromWord('ма')).toBeNull();
    expect(monthFromWord('дек.')).toBe(12);
  });
});

describe('parseNights', () => {
  it.each([
    ['7', 7, 7],
    ['5-9', 5, 9],
    ['5 - 9', 5, 9],
    ['5–9', 5, 9],
    ['от 10 до 14', 10, 14],
    ['7 ночей', 7, 7],
    ['3..5', 3, 5],
  ])('%s', (input, min, max) => {
    expect(parseNights(input)).toEqual({ ok: true, value: { min, max } });
  });

  it.each(['0', '9-5', '61', 'много', '5-70'])('ошибка для %s', (input) => {
    expect(parseNights(input).ok).toBe(false);
  });
});

describe('parsePrice', () => {
  it.each([
    ['10000', 10000],
    ['10 000', 10000],
    ['10 000', 10000],
    ['10к', 10000],
    ['10k', 10000],
    ['12.5к', 12500],
    ['12,5 тыс', 12500],
    ['9 999 ₽', 9999],
    ['15000 руб', 15000],
    ['до 15000', 15000],
  ])('%s → %d', (input, value) => {
    expect(parsePrice(input)).toEqual({ ok: true, value });
  });

  it.each(['abc', '50', '100000000', '', '1-2'])('ошибка для «%s»', (input) => {
    expect(parsePrice(input).ok).toBe(false);
  });
});

describe('parseTimeWindow', () => {
  it('разбирает окна и выключение', () => {
    expect(parseTimeWindow('23:00-08:00')).toEqual({ ok: true, value: { from: '23:00', to: '08:00' } });
    expect(parseTimeWindow('23-8')).toEqual({ ok: true, value: { from: '23:00', to: '08:00' } });
    expect(parseTimeWindow('22.30 - 7.15')).toEqual({ ok: true, value: { from: '22:30', to: '07:15' } });
    expect(parseTimeWindow('выкл')).toEqual({ ok: true, value: null });
    expect(parseTimeWindow('off')).toEqual({ ok: true, value: null });
  });

  it('отклоняет ошибки', () => {
    expect(parseTimeWindow('25:00-08:00').ok).toBe(false);
    expect(parseTimeWindow('08:00-08:00').ok).toBe(false);
    expect(parseTimeWindow('ночью').ok).toBe(false);
    expect(parseTimeWindow('10:61-11:00').ok).toBe(false);
  });
});
