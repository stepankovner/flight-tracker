import { DETECTOR } from '../config.ts';
import { addDays } from './dates.ts';
import type { IsoDate, PriceMode } from './types.ts';

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export interface DailyMinPoint {
  day: IsoDate;
  minPrice: number;
}

export type Confidence = 'high' | 'low';

export interface PriceStats {
  /** Медиана daily_min за окно (или бутстрап-медиана). */
  baseline: number | null;
  confidence: Confidence | null;
  /** Сколько дней в окне медианы. */
  baselineDays: number;
  /** Минимум за всю историю (до сегодняшнего дня). */
  historicalMin: number | null;
  /** Сколько дней истории всего (до сегодняшнего дня). */
  historyDays: number;
}

/**
 * Статистика для авто-режима. Сегодняшний день исключаем: он содержит текущие цены,
 * с которыми baseline и сравнивается.
 */
export function computeStats(history: DailyMinPoint[], today: IsoDate, bootstrapBaseline: number | null): PriceStats {
  const past = history.filter((p) => p.day < today);
  const windowStart = addDays(today, -DETECTOR.BASELINE_WINDOW_DAYS);
  const recent = past.filter((p) => p.day >= windowStart).map((p) => p.minPrice);

  let baseline: number | null = null;
  let confidence: Confidence | null = null;
  if (recent.length >= DETECTOR.BASELINE_MIN_DAYS) {
    baseline = median(recent);
    confidence = 'high';
  } else if (bootstrapBaseline !== null && bootstrapBaseline > 0) {
    baseline = bootstrapBaseline;
    confidence = 'low';
  }

  return {
    baseline,
    confidence,
    baselineDays: recent.length,
    historicalMin: past.length ? Math.min(...past.map((p) => p.minPrice)) : null,
    historyDays: past.length,
  };
}

export type Reason =
  | { kind: 'threshold'; maxPrice: number; pctBelow: number }
  | { kind: 'auto'; baseline: number; pctBelow: number; confidence: Confidence; windowDays: number }
  | { kind: 'record'; previousMin: number; historyDays: number };

export interface DetectorInput {
  priceMode: PriceMode;
  maxPrice: number | null;
  autoSensitivity: number;
}

export function pctBelow(price: number, reference: number): number {
  if (reference <= 0) return 0;
  return Math.round(((reference - price) / reference) * 100);
}

/** Требуемая скидка для авто-режима с учётом уверенности. */
export function requiredDiscount(sensitivity: number, confidence: Confidence): number {
  return confidence === 'low' ? sensitivity * DETECTOR.LOW_CONFIDENCE_MULTIPLIER : sensitivity;
}

/** Цена, ниже или равной которой авто-режим сработает (null — данных нет). */
export function autoTarget(watch: DetectorInput, stats: PriceStats): number | null {
  if (stats.baseline === null || stats.confidence === null) return null;
  return Math.floor(stats.baseline * (1 - requiredDiscount(watch.autoSensitivity, stats.confidence)));
}

/** Причины сработки для цены; пустой массив — не дёшево. */
export function evaluatePrice(price: number, watch: DetectorInput, stats: PriceStats): Reason[] {
  const reasons: Reason[] = [];
  const useThreshold = watch.priceMode === 'threshold' || watch.priceMode === 'both';
  const useAuto = watch.priceMode === 'auto' || watch.priceMode === 'both';

  if (useThreshold && watch.maxPrice !== null && price <= watch.maxPrice) {
    reasons.push({ kind: 'threshold', maxPrice: watch.maxPrice, pctBelow: pctBelow(price, watch.maxPrice) });
  }

  if (useAuto) {
    const target = autoTarget(watch, stats);
    if (target !== null && price <= target && stats.baseline !== null && stats.confidence !== null) {
      reasons.push({
        kind: 'auto',
        baseline: stats.baseline,
        pctBelow: pctBelow(price, stats.baseline),
        confidence: stats.confidence,
        windowDays: DETECTOR.BASELINE_WINDOW_DAYS,
      });
    }
    if (
      stats.historicalMin !== null &&
      stats.historyDays >= DETECTOR.RECORD_MIN_DAYS &&
      price < stats.historicalMin
    ) {
      reasons.push({ kind: 'record', previousMin: stats.historicalMin, historyDays: stats.historyDays });
    }
  }
  return reasons;
}

/**
 * «Целевая» цена для решения о догрузке следующей страницы: всё, что дешевле, может сработать.
 * null — порога нет (догружать не нужно).
 */
export function fetchTarget(watch: DetectorInput, stats: PriceStats): number | null {
  const targets: number[] = [];
  if ((watch.priceMode === 'threshold' || watch.priceMode === 'both') && watch.maxPrice !== null) {
    targets.push(watch.maxPrice);
  }
  if (watch.priceMode !== 'threshold') {
    const t = autoTarget(watch, stats);
    if (t !== null) targets.push(t);
    if (stats.historicalMin !== null && stats.historyDays >= DETECTOR.RECORD_MIN_DAYS) {
      targets.push(stats.historicalMin - 1);
    }
  }
  return targets.length ? Math.max(...targets) : null;
}
