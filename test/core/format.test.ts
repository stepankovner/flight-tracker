import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  daysBetween,
  isIsoDate,
  isValidTimeZone,
  localParts,
  monthsBetween,
  tzOffsetMinutes,
  weekdayOf,
  zonedDayStart,
} from '../../src/core/dates.ts';
import {
  ageText,
  describeWatch,
  escapeHtml,
  fmtDate,
  fmtDateRange,
  fmtDuration,
  fmtPrice,
  plural,
  reasonText,
  renderAlert,
  renderDigest,
  type AlertPayload,
  type NameBook,
} from '../../src/core/format.ts';
import { buildBuyLink, buildSearchPath, searchDateFromLink } from '../../src/core/links.ts';
import { offer, spec } from '../helpers.ts';

const NBSP = ' ';
const NOW = new Date('2026-09-28T15:00:00Z');
const names: NameBook = {
  places: {
    MOW: { kind: 'city', name: 'Москва', cityName: 'Москва' },
    IST: { kind: 'city', name: 'Стамбул', cityName: 'Стамбул' },
    SVO: { kind: 'airport', name: 'Шереметьево', cityName: 'Москва' },
    SAW: { kind: 'airport', name: 'Сабиха Гёкчен', cityName: 'Стамбул' },
  },
  airlines: { PC: 'Pegasus Airlines' },
};

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
  return {
    v: 1,
    mode: 'alert',
    watchId: 12,
    origins: ['MOW'],
    destinations: ['IST'],
    tripType: 'roundtrip',
    adults: 1,
    currency: 'rub',
    priceMode: 'threshold',
    maxPrice: 10000,
    offers: [{ offer: offer({ destAirport: 'SAW' }), reasons: [{ kind: 'threshold', maxPrice: 10000, pctBelow: 16 }] }],
    total: 1,
    checkedAt: NOW.toISOString(),
    ...over,
  };
}

describe('dates', () => {
  it('арифметика дат', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthsBetween('2026-11-20', '2027-01-02')).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(monthsBetween('2026-11-20', '2026-11-01')).toEqual([]);
    expect(daysBetween('2026-11-29', '2026-12-01')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01']);
    expect(weekdayOf('2026-09-28')).toBe(1);
    expect(weekdayOf('2026-10-04')).toBe(7);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });

  it('часовые пояса и переход на зимнее время', () => {
    expect(tzOffsetMinutes(NOW, 'Europe/Moscow')).toBe(180);
    expect(tzOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'Europe/Berlin')).toBe(120);
    expect(tzOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'Europe/Berlin')).toBe(60);
    // 25.10.2026 в Берлине переход CEST→CET: сутки начинаются ещё по летнему времени
    expect(zonedDayStart('2026-10-25', 'Europe/Berlin').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(zonedDayStart('2026-10-26', 'Europe/Berlin').toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(localParts(NOW, 'Europe/Moscow')).toEqual({ date: '2026-09-28', time: '18:00', minutes: 1080 });
    expect(isValidTimeZone('Europe/Moscow')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('форматирование', () => {
  it('цены, даты, склонения', () => {
    expect(fmtPrice(8450)).toBe(`8${NBSP}450${NBSP}₽`);
    expect(fmtPrice(1234567, 'usd')).toBe(`1${NBSP}234${NBSP}567${NBSP}$`);
    expect(fmtPrice(99, 'xyz')).toBe(`99${NBSP}XYZ`);
    expect(fmtDate('2026-11-12')).toBe('12 ноя (чт)');
    expect(fmtDateRange('2026-11-15', '2026-11-30')).toBe('15 ноя – 30 ноя 2026');
    expect(fmtDateRange('2026-12-25', '2027-01-10')).toBe('25 дек 2026 – 10 янв 2027');
    expect(fmtDateRange('2026-11-15', '2026-11-15')).toBe('15 ноя 2026');
    expect(plural(1, ['ночь', 'ночи', 'ночей'])).toBe('ночь');
    expect(plural(3, ['ночь', 'ночи', 'ночей'])).toBe('ночи');
    expect(plural(11, ['ночь', 'ночи', 'ночей'])).toBe('ночей');
    expect(plural(21, ['ночь', 'ночи', 'ночей'])).toBe('ночь');
    expect(fmtDuration(45)).toBe('45 мин');
    expect(fmtDuration(120)).toBe('2 ч');
    expect(fmtDuration(200)).toBe('3 ч 20 мин');
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('причины сработки', () => {
    expect(reasonText({ kind: 'threshold', maxPrice: 10000, pctBelow: 15 }, 'rub')).toBe(`ниже твоего порога 10${NBSP}000${NBSP}₽ на 15%`);
    expect(reasonText({ kind: 'auto', baseline: 11600, pctBelow: 27, confidence: 'high', windowDays: 21 }, 'rub')).toBe(
      `на 27% ниже медианы за 21 день (11${NBSP}600${NBSP}₽)`,
    );
    expect(reasonText({ kind: 'auto', baseline: 11600, pctBelow: 30, confidence: 'low', windowDays: 21 }, 'rub')).toMatch(/оценка/);
    expect(reasonText({ kind: 'record', previousMin: 9000, historyDays: 12 }, 'rub')).toMatch(/новый минимум/);
  });

  it('возраст цены: found_at → часы, иначе search_date из ссылки', () => {
    expect(ageText([offer({ foundAt: '2026-09-28T12:00:00Z' })], NOW, '2026-09-28')).toBe('~3 ч назад');
    expect(ageText([offer({ foundAt: '2026-09-28T14:40:00Z' })], NOW, '2026-09-28')).toBe('меньше часа назад');
    expect(ageText([offer()], NOW, '2026-09-28')).toBe('сегодня');
    expect(ageText([offer({ link: '/search/x?search_date=27092026' })], NOW, '2026-09-28')).toBe('вчера');
    expect(ageText([offer({ link: '/search/x?search_date=25092026' })], NOW, '2026-09-28')).toBe('3 дня назад');
    expect(ageText([offer({ link: '/search/x' })], NOW, '2026-09-28')).toBe('за последние ~48 ч');
  });

  it('уведомление об одном билете — формат из ТЗ', () => {
    const r = renderAlert(payload(), { names, now: NOW, marker: null, outboxId: 55 });
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('✈️ <b>Москва (SVO) → Стамбул (SAW)</b>');
    expect(lines[1]).toBe(`💰 <b>8${NBSP}450${NBSP}₽</b> — ниже твоего порога 10${NBSP}000${NBSP}₽ на 16%`);
    expect(lines[2]).toBe('📅 18 ноя (ср) 06:40 → 25 ноя (ср) 18:20, 7 ночей');
    expect(lines[3]).toBe(`🔁 1 пересадка туда · прямой обратно · Pegasus Airlines PC${NBSP}395`);
    expect(r.text).toContain('🕒 Цена из кэша Aviasales, найдена сегодня — проверь перед покупкой');
    expect(r.keyboard[0]).toEqual([
      { text: 'Купить на Aviasales', url: expect.stringContaining('https://www.aviasales.ru/search/SVO1811IST25111') },
      { text: '🔕 Не показывать этот рейс', callback_data: 'a:mute:55:0' },
    ]);
    expect(r.keyboard[1]).toEqual([{ text: '⏸ Пауза watch', callback_data: 'a:pause:12' }]);
  });

  it('несколько вариантов: топ-3 + «ещё N» + «Показать все»', () => {
    const offers = [8000, 8500, 9000, 9500, 9900].map((price, i) => ({
      offer: offer({ price, flightNumber: String(100 + i) }),
      reasons: [{ kind: 'threshold' as const, maxPrice: 10000, pctBelow: 10 }],
    }));
    const p = payload({ offers, total: 7 });
    const r = renderAlert(p, { names, now: NOW, marker: 'M1', outboxId: 9 });
    expect(r.text).toContain('Нашёл 7 дешёвых вариантов');
    expect(r.text).toContain('…и ещё 4 варианта');
    expect(r.keyboard).toHaveLength(4);
    expect(r.keyboard[0]![0]).toMatchObject({ text: `🛒 1 · 8${NBSP}000${NBSP}₽` });
    expect((r.keyboard[0]![0] as { url: string }).url).toContain('marker=M1');
    expect(r.keyboard[3]).toEqual([
      { text: '📋 Показать все (5)', callback_data: 'a:more:9' },
      { text: '⏸ Пауза watch', callback_data: 'a:pause:12' },
    ]);
    const all = renderAlert(p, { names, now: NOW, marker: null, outboxId: 9 }, true);
    expect(all.keyboard).toHaveLength(6);
    expect(all.text).toContain('…и ещё 2 варианта');
  });

  it('несколько взрослых — оценка общей стоимости', () => {
    const r = renderAlert(payload({ adults: 2 }), { names, now: NOW, marker: null, outboxId: 1 });
    expect(r.text).toContain(`👥 ≈ 16${NBSP}900${NBSP}₽ за 2 взрослых (оценка)`);
    expect((r.keyboard[0]![0] as { url: string }).url).toContain('/search/SVO1811IST25112');
  });

  it('точка отсчёта и пустой результат', () => {
    const initial = renderAlert(payload({ mode: 'initial', offers: [{ offer: offer({ price: 12000 }), reasons: [] }], baseline: null, autoTarget: null }), {
      names,
      now: NOW,
      marker: null,
      outboxId: 3,
    });
    expect(initial.text).toContain('✅ <b>Наблюдение #12 создано</b>');
    expect(initial.text).toContain('📍 Точка отсчёта');
    expect(initial.text).toContain(`🎯 порог 10${NBSP}000${NBSP}₽`);
    expect(initial.keyboard[0]).toHaveLength(1); // без «не показывать»

    const empty = renderAlert(payload({ mode: 'manual', offers: [], total: 0, priceMode: 'auto', maxPrice: null }), { names, now: NOW, marker: null, outboxId: 4 });
    expect(empty.text).toContain('нет подходящих билетов');
    expect(empty.text).toContain('авто: пока копим историю цен');
  });

  it('дайджест', () => {
    const r = renderDigest(
      [
        { outboxId: 1, createdAt: NOW.toISOString(), payload: payload() },
        { outboxId: 2, createdAt: NOW.toISOString(), payload: payload({ watchId: 13, total: 5 }) },
      ],
      { names, now: NOW, marker: null, tz: 'Europe/Moscow', maxOffers: 10 },
    );
    expect(r.text).toContain('Отложенные уведомления (2)');
    expect(r.text).toContain('#13');
    expect(r.text).toContain('…и ещё 4 варианта');
    expect(r.keyboard).toHaveLength(2);
  });

  it('описание наблюдения', () => {
    const text = describeWatch(spec({ directOnly: true, departWeekdays: [5, 1], adults: 2, returnTo: '2026-12-10', priceMode: 'both' }), names, 'rub');
    expect(text).toContain('✈️ Москва → Стамбул (туда-обратно)');
    expect(text).toContain('📅 вылет 15 ноя – 30 ноя 2026 · 6–9 ночей · вернуться до 10 дек');
    expect(text).toContain('🔎 только прямые · вылет: Пн, Пт · 2 взрослых');
    expect(text).toContain(`💰 до 10${NBSP}000${NBSP}₽ или авто (−20% от медианы)`);
  });
});

describe('ссылки', () => {
  it('поисковый путь Aviasales', () => {
    expect(buildSearchPath({ origin: 'MOW', destination: 'IST', departDate: '2026-11-12', returnDate: '2026-11-19', adults: 1 })).toBe('/search/MOW1211IST19111');
    expect(buildSearchPath({ origin: 'MOW', destination: 'IST', departDate: '2026-11-12', returnDate: null, adults: 2 })).toBe('/search/MOW1211IST2');
  });

  it('ссылка из API + marker', () => {
    const url = buildBuyLink(offer(), { adults: 1, marker: '12345' });
    expect(url.startsWith('https://www.aviasales.ru/search/SVO1811IST25111?t=PC_abc')).toBe(true);
    expect(new URL(url).searchParams.get('marker')).toBe('12345');
    expect(new URL(url).searchParams.get('search_date')).toBe('28092026');
  });

  it('пустая ссылка → поисковая', () => {
    expect(buildBuyLink(offer({ link: '' }), { adults: 3 })).toBe('https://www.aviasales.ru/search/SVO1811IST25113');
  });

  it('search_date из ссылки', () => {
    expect(searchDateFromLink('/search/X?t=1&search_date=11052023&x=1')).toBe('2023-05-11');
    expect(searchDateFromLink('/search/X')).toBeNull();
  });
});
