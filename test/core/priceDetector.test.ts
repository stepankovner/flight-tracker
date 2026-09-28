import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates.ts';
import {
  autoTarget,
  computeStats,
  evaluatePrice,
  fetchTarget,
  median,
  pctBelow,
  requiredDiscount,
  type DailyMinPoint,
} from '../../src/core/priceDetector.ts';

const TODAY = '2026-10-10';

/** Синтетический ряд: values[0] — вчера, values[1] — позавчера и т.д. */
function series(values: number[], today = TODAY): DailyMinPoint[] {
  return values.map((v, i) => ({ day: addDays(today, -(i + 1)), minPrice: v }));
}

const auto = { priceMode: 'auto' as const, maxPrice: null, autoSensitivity: 0.2 };

describe('median', () => {
  it('нечётное, чётное, пустое', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3); // (2+3)/2 = 2.5 → округление до 3
    expect(median([10000, 12000])).toBe(11000);
    expect(median([])).toBeNull();
  });
});

describe('computeStats', () => {
  it('холодный старт: < 5 дней — бутстрап с low confidence', () => {
    const s = computeStats(series([10000, 11000, 12000]), TODAY, 13000);
    expect(s).toMatchObject({ baseline: 13000, confidence: 'low', baselineDays: 3, historyDays: 3, historicalMin: 10000 });
  });

  it('нет ни истории, ни бутстрапа — baseline неизвестен', () => {
    expect(computeStats([], TODAY, null)).toMatchObject({ baseline: null, confidence: null, historicalMin: null, historyDays: 0 });
  });

  it('≥ 5 дней — медиана за 21 день, high confidence', () => {
    const s = computeStats(series([10000, 11000, 12000, 13000, 14000]), TODAY, 99999);
    expect(s).toMatchObject({ baseline: 12000, confidence: 'high', baselineDays: 5 });
  });

  it('сегодняшний день не участвует; дни старше 21 — только в историческом минимуме', () => {
    const points = [
      { day: TODAY, minPrice: 1000 },
      ...series([10000, 10000, 10000, 10000, 10000]),
      { day: addDays(TODAY, -30), minPrice: 5000 },
    ];
    const s = computeStats(points, TODAY, null);
    expect(s.baseline).toBe(10000);
    expect(s.baselineDays).toBe(5);
    expect(s.historicalMin).toBe(5000);
    expect(s.historyDays).toBe(6);
  });
});

describe('evaluatePrice', () => {
  it('threshold: цена ≤ max_price', () => {
    const w = { priceMode: 'threshold' as const, maxPrice: 10000, autoSensitivity: 0.2 };
    const stats = computeStats([], TODAY, null);
    expect(evaluatePrice(8450, w, stats)).toEqual([{ kind: 'threshold', maxPrice: 10000, pctBelow: 16 }]);
    expect(evaluatePrice(10000, w, stats)).toEqual([{ kind: 'threshold', maxPrice: 10000, pctBelow: 0 }]);
    expect(evaluatePrice(10001, w, stats)).toEqual([]);
  });

  it('auto (high): −20% к медиане', () => {
    const stats = computeStats(series([10000, 10000, 10000, 10000, 10000]), TODAY, null);
    expect(autoTarget(auto, stats)).toBe(8000);
    expect(evaluatePrice(8000, auto, stats)).toEqual([{ kind: 'auto', baseline: 10000, pctBelow: 20, confidence: 'high', windowDays: 21 }]);
    expect(evaluatePrice(8500, auto, stats)).toEqual([]);
  });

  it('auto (low confidence): скидка в 1.5 раза больше', () => {
    const stats = computeStats(series([12000]), TODAY, 10000);
    expect(requiredDiscount(0.2, 'low')).toBeCloseTo(0.3);
    expect(autoTarget(auto, stats)).toBe(7000);
    expect(evaluatePrice(7500, auto, stats)).toEqual([]);
    expect(evaluatePrice(7000, auto, stats)[0]).toMatchObject({ kind: 'auto', confidence: 'low', pctBelow: 30 });
  });

  it('новый рекорд — только при ≥ 7 днях истории', () => {
    const six = computeStats(series([9000, 9500, 9500, 9500, 9500, 9500]), TODAY, null);
    expect(evaluatePrice(8900, auto, six).map((r) => r.kind)).toEqual([]);
    const seven = computeStats(series([9000, 9500, 9500, 9500, 9500, 9500, 9500]), TODAY, null);
    expect(evaluatePrice(8900, auto, seven)).toEqual([{ kind: 'record', previousMin: 9000, historyDays: 7 }]);
    expect(evaluatePrice(9000, auto, seven)).toEqual([]);
  });

  it('both: причины объединяются', () => {
    const w = { priceMode: 'both' as const, maxPrice: 9000, autoSensitivity: 0.2 };
    const stats = computeStats(series([10000, 10000, 10000, 10000, 10000, 10000, 10000]), TODAY, null);
    expect(evaluatePrice(7500, w, stats).map((r) => r.kind)).toEqual(['threshold', 'auto', 'record']);
    expect(evaluatePrice(8900, w, stats).map((r) => r.kind)).toEqual(['threshold', 'record']);
    expect(evaluatePrice(9500, w, stats).map((r) => r.kind)).toEqual(['record']);
  });

  it('threshold-режим не срабатывает по авто-условиям и наоборот', () => {
    const stats = computeStats(series([10000, 10000, 10000, 10000, 10000, 10000, 10000]), TODAY, null);
    expect(evaluatePrice(5000, { priceMode: 'threshold', maxPrice: 4000, autoSensitivity: 0.2 }, stats)).toEqual([]);
    expect(evaluatePrice(11000, { priceMode: 'auto', maxPrice: 20000, autoSensitivity: 0.2 }, stats)).toEqual([]);
  });

  it('pctBelow', () => {
    expect(pctBelow(8450, 10000)).toBe(16);
    expect(pctBelow(10, 0)).toBe(0);
  });
});

describe('fetchTarget', () => {
  it('максимум из применимых порогов', () => {
    const stats = computeStats(series([10000, 10000, 10000, 10000, 10000, 10000, 10000]), TODAY, null);
    expect(fetchTarget({ priceMode: 'threshold', maxPrice: 9000, autoSensitivity: 0.2 }, stats)).toBe(9000);
    expect(fetchTarget({ priceMode: 'auto', maxPrice: null, autoSensitivity: 0.2 }, stats)).toBe(9999);
    expect(fetchTarget({ priceMode: 'both', maxPrice: 12000, autoSensitivity: 0.2 }, stats)).toBe(12000);
    expect(fetchTarget({ priceMode: 'auto', maxPrice: null, autoSensitivity: 0.2 }, computeStats([], TODAY, null))).toBeNull();
  });
});
