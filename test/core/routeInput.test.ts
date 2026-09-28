import { describe, expect, it } from 'vitest';
import { splitRoute } from '../../src/core/routeInput.ts';

describe('splitRoute', () => {
  it.each([
    ['Москва - Алматы', 'Москва', 'Алматы'],
    ['москва -алматы', 'москва', 'алматы'],
    ['Москва — Алматы', 'Москва', 'Алматы'],
    ['Москва–Алматы', 'Москва', 'Алматы'],
    ['Москва → Алматы', 'Москва', 'Алматы'],
    ['Москва->Алматы', 'Москва', 'Алматы'],
    ['из Москвы в Алматы', 'Москвы', 'Алматы'],
    ['Из Питера во Владивосток', 'Питера', 'Владивосток'],
    ['Москва, Питер - Стамбул, Анталья', 'Москва, Питер', 'Стамбул, Анталья'],
    ['Санкт-Петербург - Стамбул', 'Санкт-Петербург', 'Стамбул'],
    ['MOW - IST', 'MOW', 'IST'],
  ])('%s', (input, from, to) => {
    expect(splitRoute(input)).toEqual({ from, to, strict: true });
  });

  it('голый дефис — кандидат, но не наверняка (может быть одно название)', () => {
    expect(splitRoute('москва-алматы')).toEqual({ from: 'москва', to: 'алматы', strict: false });
    expect(splitRoute('Улан-Удэ')).toEqual({ from: 'Улан', to: 'Удэ', strict: false });
  });

  it('не маршрут', () => {
    expect(splitRoute('Москва')).toBeNull();
    expect(splitRoute('Москва, Питер')).toBeNull();
    expect(splitRoute('Ростов-на-Дону')).toBeNull();
    expect(splitRoute('')).toBeNull();
    expect(splitRoute(' - ')).toBeNull();
    expect(splitRoute('Москва -')).toBeNull();
  });
});
