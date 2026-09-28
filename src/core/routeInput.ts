/**
 * Разбор маршрута, введённого одной строкой на шаге «Откуда»: «Москва - Алматы», «Москва → Алматы»,
 * «из Москвы в Алматы», «Москва, Питер — Стамбул». Чистая функция.
 */
export interface RouteInput {
  from: string;
  to: string;
  /**
   * false — разделитель лишь «голый» дефис без пробелов («москва-алматы»): это может быть и одно
   * название («Улан-Удэ», «Санкт-Петербург»), вызывающий сначала проверяет строку целиком.
   */
  strict: boolean;
}

const clean = (s: string) => s.trim().replace(/^[,;]+|[,;]+$/g, '').trim();

export function splitRoute(input: string): RouteInput | null {
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s) return null;

  // «из Москвы в Алматы», «из Москвы, Питера в Стамбул»
  let m = /^из (.+?) (?:в|во|до) (.+)$/i.exec(s);
  if (m) return pair(m[1]!, m[2]!, true);

  // стрелки, тире и дефис с пробелами
  m = /^(.+?)\s*(?:→|->|=>|—|–|\s-\s|\s-|-\s)\s*(.+)$/.exec(s);
  if (m) return pair(m[1]!, m[2]!, true);

  // единственный дефис без пробелов между двумя словами
  const hyphens = s.split('-').length - 1;
  if (hyphens === 1) {
    const [a, b] = s.split('-') as [string, string];
    if (/[a-zа-яё]$/i.test(a) && /^[a-zа-яё]/i.test(b)) return pair(a, b, false);
  }
  return null;
}

function pair(from: string, to: string, strict: boolean): RouteInput | null {
  const f = clean(from);
  const t = clean(to);
  return f && t ? { from: f, to: t, strict } : null;
}
