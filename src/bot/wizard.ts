import { BOT, BUDGET, DETECTOR, FILTERS, PLANNER } from '../config.ts';
import { todayIn } from '../core/dates.ts';
import { parseDateRange, parseNights, parsePrice } from '../core/dateParser.ts';
import {
  datesLine,
  describeWatch,
  escapeHtml,
  fmtDate,
  fmtNumber,
  fmtPrice,
  fmtWeekdays,
  WEEKDAY_LABELS,
  type Button,
  type Keyboard,
  type NameBook,
} from '../core/format.ts';
import { planQueries } from '../core/queryPlanner.ts';
import type { PriceMode, TripType, Watch, WatchSpec } from '../core/types.ts';
import { runInitialCheck } from '../jobs/manual.ts';
import { previewPrices } from '../jobs/preview.ts';
import { choosePlace, placeLabel, type Place } from '../providers/autocomplete.ts';
import { ProviderError } from '../providers/FareProvider.ts';
import { ack, BACK_CANCEL_ROW, btn, CANCEL_ROW, show, type BotContext } from './ui.ts';

// ---------- Черновик ----------

export interface PlaceRef {
  code: string;
  name: string;
}

type PlaceField = 'origins' | 'destinations';

export type Step =
  | 'origins'
  | 'origins_pick'
  | 'destinations'
  | 'destinations_pick'
  | 'type'
  | 'dates'
  | 'nights'
  | 'filters'
  | 'weekdays'
  | 'return_to'
  | 'price'
  | 'price_input'
  | 'confirm';

export interface Draft {
  v: 1;
  editingWatchId: number | null;
  origins: PlaceRef[];
  destinations: PlaceRef[];
  tripType: TripType | null;
  departFrom: string | null;
  departTo: string | null;
  nightsMin: number | null;
  nightsMax: number | null;
  returnTo: string | null;
  departWeekdays: number[];
  directOnly: boolean;
  maxTransfers: number | null;
  noNight: boolean;
  adults: number;
  priceMode: PriceMode | null;
  maxPrice: number | null;
  autoSensitivity: number;
  /** Поля watch, которые мастер не редактирует, — сохраняем как есть. */
  keep: Pick<WatchSpec, 'returnWeekdays' | 'maxDurationMin' | 'excludeAirlines' | 'departTimeFrom' | 'departTimeTo'>;
  /** Правка раздела с экрана подтверждения — после неё вернуться туда. */
  toConfirm: boolean;
  pick: { field: PlaceField; queue: Array<{ term: string; options: PlaceRef[] }>; resolved: PlaceRef[] } | null;
  pendingMode: PriceMode | null;
  hint: { price: number; line: string } | null;
  hintChecked: boolean;
}

export function newDraft(): Draft {
  return {
    v: 1,
    editingWatchId: null,
    origins: [],
    destinations: [],
    tripType: null,
    departFrom: null,
    departTo: null,
    nightsMin: null,
    nightsMax: null,
    returnTo: null,
    departWeekdays: [],
    directOnly: false,
    maxTransfers: null,
    noNight: false,
    adults: 1,
    priceMode: null,
    maxPrice: null,
    autoSensitivity: DETECTOR.DEFAULT_SENSITIVITY,
    keep: { returnWeekdays: null, maxDurationMin: null, excludeAirlines: null, departTimeFrom: null, departTimeTo: null },
    toConfirm: false,
    pick: null,
    pendingMode: null,
    hint: null,
    hintChecked: false,
  };
}

export function draftFromWatch(w: Watch, names: NameBook): Draft {
  const noNight = w.departTimeFrom === FILTERS.NO_NIGHT_FROM && w.departTimeTo === FILTERS.NO_NIGHT_TO;
  const ref = (code: string): PlaceRef => ({ code, name: names.places[code]?.name ?? code });
  return {
    ...newDraft(),
    editingWatchId: w.id,
    origins: w.origins.map(ref),
    destinations: w.destinations.map(ref),
    tripType: w.tripType,
    departFrom: w.departFrom,
    departTo: w.departTo,
    nightsMin: w.nightsMin,
    nightsMax: w.nightsMax,
    returnTo: w.returnTo,
    departWeekdays: w.departWeekdays ?? [],
    directOnly: w.directOnly,
    maxTransfers: w.maxTransfers,
    noNight,
    adults: w.adults,
    priceMode: w.priceMode,
    maxPrice: w.maxPrice,
    autoSensitivity: w.autoSensitivity,
    keep: {
      returnWeekdays: w.returnWeekdays,
      maxDurationMin: w.maxDurationMin,
      excludeAirlines: w.excludeAirlines,
      departTimeFrom: noNight ? null : w.departTimeFrom,
      departTimeTo: noNight ? null : w.departTimeTo,
    },
    toConfirm: true,
  };
}

/** Черновик → WatchSpec (null, если чего-то не хватает). */
export function specFromDraft(d: Draft): WatchSpec | null {
  if (!d.origins.length || !d.destinations.length || !d.tripType || !d.departFrom || !d.departTo || !d.priceMode) return null;
  if (d.tripType === 'roundtrip' && (d.nightsMin === null || d.nightsMax === null)) return null;
  if (d.priceMode !== 'auto' && d.maxPrice === null) return null;
  return {
    origins: d.origins.map((p) => p.code),
    destinations: d.destinations.map((p) => p.code),
    tripType: d.tripType,
    departFrom: d.departFrom,
    departTo: d.departTo,
    nightsMin: d.tripType === 'roundtrip' ? d.nightsMin : null,
    nightsMax: d.tripType === 'roundtrip' ? d.nightsMax : null,
    returnTo: d.tripType === 'roundtrip' ? d.returnTo : null,
    departWeekdays: d.departWeekdays.length && d.departWeekdays.length < 7 ? [...d.departWeekdays].sort((a, b) => a - b) : null,
    returnWeekdays: d.keep.returnWeekdays,
    directOnly: d.directOnly,
    maxTransfers: d.directOnly ? null : d.maxTransfers,
    maxDurationMin: d.keep.maxDurationMin,
    excludeAirlines: d.keep.excludeAirlines,
    departTimeFrom: d.noNight ? FILTERS.NO_NIGHT_FROM : d.keep.departTimeFrom,
    departTimeTo: d.noNight ? FILTERS.NO_NIGHT_TO : d.keep.departTimeTo,
    adults: d.adults,
    priceMode: d.priceMode,
    maxPrice: d.priceMode === 'auto' ? null : d.maxPrice,
    autoSensitivity: d.autoSensitivity,
  };
}

/** Спецификация для подсказки цены — без ценовых полей. */
function previewSpec(d: Draft): WatchSpec | null {
  return specFromDraft({ ...d, priceMode: 'auto', maxPrice: null });
}

function namesOf(d: Draft): NameBook {
  const places: NameBook['places'] = {};
  for (const p of [...d.origins, ...d.destinations]) places[p.code] = { kind: 'city', name: p.name, cityName: p.name };
  return { places, airlines: {} };
}

// ---------- Состояние ----------

async function save(ctx: BotContext, step: Step, d: Draft): Promise<void> {
  await ctx.svc.repo.setWizard(ctx.user.tgUserId, step, JSON.stringify(d), ctx.svc.now().toISOString());
}

export async function loadWizard(ctx: BotContext): Promise<{ step: Step; draft: Draft } | null> {
  const st = await ctx.svc.repo.getWizard(ctx.user.tgUserId);
  if (!st || st.step.startsWith('settings:')) return null;
  if (ctx.svc.now().getTime() - Date.parse(st.updatedAt) > BOT.WIZARD_TTL_MIN * 60_000) {
    await ctx.svc.repo.clearWizard(ctx.user.tgUserId);
    return null;
  }
  try {
    const draft = JSON.parse(st.draft) as Draft;
    if (draft.v !== 1) return null;
    return { step: st.step as Step, draft };
  } catch {
    return null;
  }
}

// ---------- Экраны ----------

function nightsText(d: Draft): string {
  if (d.nightsMin === null || d.nightsMax === null) return '—';
  return d.nightsMin === d.nightsMax ? `${d.nightsMin}` : `${d.nightsMin}–${d.nightsMax}`;
}

function filtersKeyboard(d: Draft): Keyboard {
  const rows: Keyboard = [[btn(`✈️ Только прямые: ${d.directOnly ? 'да' : 'нет'}`, 'w:f:d')]];
  if (!d.directOnly) rows.push([btn(`🔁 Пересадок: ${d.maxTransfers === null ? 'любое число' : `не больше ${d.maxTransfers}`}`, 'w:f:t')]);
  rows.push([btn(`📅 Дни вылета: ${d.departWeekdays.length && d.departWeekdays.length < 7 ? fmtWeekdays(d.departWeekdays) : 'любые'}`, 'w:f:w')]);
  rows.push([btn(`🌙 Ночные вылеты: ${d.noNight ? 'не надо' : 'можно'}`, 'w:f:n')]);
  rows.push([btn(`👥 Взрослых: ${d.adults}`, 'w:f:a')]);
  if (d.tripType === 'roundtrip') {
    rows.push([btn(`↩️ Вернуться не позже: ${d.returnTo ? fmtDate(d.returnTo, false) : '—'}`, 'w:f:r')]);
  }
  rows.push([btn('Далее →', 'w:f:ok')]);
  rows.push(BACK_CANCEL_ROW);
  return rows;
}

function weekdaysKeyboard(d: Draft): Keyboard {
  const day = (n: number) => btn(`${d.departWeekdays.includes(n) ? '✅ ' : ''}${WEEKDAY_LABELS[n - 1]}`, `w:wd:${n}`);
  return [[day(1), day(2), day(3), day(4)], [day(5), day(6), day(7)], [btn('Любые дни', 'w:wd:all'), btn('Готово', 'w:wd:ok')]];
}

function priceInputKeyboard(d: Draft): Keyboard {
  const rows: Keyboard = [];
  if (d.hint) {
    const round = (n: number) => Math.max(100, Math.round(n / 100) * 100);
    const values = [...new Set([round(d.hint.price * 0.8), round(d.hint.price * 0.9), round(d.hint.price)])];
    rows.push(values.map((v) => btn(fmtPrice(v), `w:pv:${v}`)));
  }
  rows.push(BACK_CANCEL_ROW);
  return rows;
}

async function screen(ctx: BotContext, step: Step, d: Draft, edit: boolean): Promise<void> {
  const nav = d.toConfirm ? [btn('← К сводке', 'w:b'), btn('✖️ Отмена', 'w:x')] : step === 'origins' ? CANCEL_ROW : BACK_CANCEL_ROW;
  const currency = ctx.user.currency;
  switch (step) {
    case 'origins':
      return show(ctx, '🛫 <b>Откуда летим?</b>\nГород или код аэропорта. Можно несколько через запятую: «Москва, Питер».', [nav], { edit });
    case 'destinations':
      return show(ctx, '🛬 <b>Куда?</b>\nГород или код аэропорта, можно несколько через запятую: «Стамбул, Анталья».', [nav], { edit });
    case 'origins_pick':
    case 'destinations_pick': {
      const cur = d.pick?.queue[0];
      if (!cur) return;
      const rows: Keyboard = cur.options.map((o, i) => [btn(o.name, `w:p:${i}`)]);
      rows.push(nav);
      return show(ctx, `Уточни, что имелось в виду под «${escapeHtml(cur.term)}»:`, rows, { edit });
    }
    case 'type':
      return show(ctx, '🔄 <b>Тип поездки?</b>', [[btn('Туда-обратно', 'w:t:rt'), btn('В одну сторону', 'w:t:ow')], nav], { edit });
    case 'dates':
      return show(
        ctx,
        '📅 <b>Даты вылета</b> — окно, в которое готов вылететь. Примеры:\n' +
          '<code>15.11-30.11</code> · <code>15.11.2026-02.12.2026</code> · <code>ноябрь</code> · ' +
          '<code>ноябрь-декабрь</code> · <code>15.11</code> · <code>±3 от 20.11</code>',
        [nav],
        { edit },
      );
    case 'nights':
      return show(
        ctx,
        '🌙 <b>Сколько ночей?</b> Напиши число или диапазон (<code>7</code>, <code>5-9</code>) или выбери:',
        [[btn('3–5', 'w:n:3-5'), btn('6–9', 'w:n:6-9'), btn('10–14', 'w:n:10-14')], nav],
        { edit },
      );
    case 'filters':
      return show(ctx, '🔎 <b>Фильтры</b> — можно сразу нажать «Далее».', filtersKeyboard(d), { edit });
    case 'weekdays':
      return show(ctx, '📅 В какие дни недели вылетать?', weekdaysKeyboard(d), { edit });
    case 'return_to':
      return show(ctx, '↩️ До какой даты нужно вернуться? Например <code>10.12</code>.', [[btn('Без ограничения', 'w:r:none')], BACK_CANCEL_ROW], { edit });
    case 'price': {
      let text = '💰 <b>Когда присылать уведомление?</b>\n';
      if (d.hint) text += `\n💡 Сейчас самое дешёвое в твоём окне: ${d.hint.line}\n`;
      else if (d.hintChecked) text += '\n💡 Сейчас в кэше Aviasales нет подходящих билетов — ориентира по цене пока нет.\n';
      text +=
        '\n• <b>Порог</b> — сообщу, когда цена за 1 взрослого будет не выше заданной.' +
        '\n• <b>Авто</b> — бот сам копит историю цен и сообщает о заметном падении (от −20% к медиане) и новых минимумах.' +
        '\n• <b>Оба</b> — сработает любое из условий.';
      return show(
        ctx,
        text,
        [[btn('💰 Ввести максимум', 'w:pm:threshold')], [btn('🤖 Пусть бот решает сам', 'w:pm:auto')], [btn('🔀 Оба варианта', 'w:pm:both')], nav],
        { edit },
      );
    }
    case 'price_input':
      return show(ctx, `Максимальная цена за 1 взрослого (${currency === 'rub' ? '₽' : currency.toUpperCase()}), например <code>12000</code> или <code>12к</code>:`, priceInputKeyboard(d), { edit });
    case 'confirm': {
      const spec = specFromDraft(d);
      if (!spec) return goto(ctx, firstMissing(d), d, edit);
      const plan = planQueries(spec, todayIn(ctx.svc.now(), ctx.user.tz), { currency, market: ctx.svc.cfg.market });
      let text = `${d.editingWatchId ? `✏️ <b>Наблюдение #${d.editingWatchId}</b>` : '📝 <b>Проверь наблюдение</b>'}\n\n${describeWatch(spec, namesOf(d), currency)}\n`;
      if (plan.ok) {
        text += `\nПроверяю раз в ${BOT.DEFAULT_CHECK_INTERVAL_MIN} мин, запросов к API за проверку: ${plan.value.length}.`;
      } else {
        text += `\n⚠️ ${escapeHtml(plan.error.message)}`;
      }
      const rows: Keyboard = [];
      if (plan.ok) rows.push([btn(d.editingWatchId ? '💾 Сохранить' : '✅ Создать', 'w:ok')]);
      rows.push([btn('Откуда', 'w:e:o'), btn('Куда', 'w:e:d'), btn('Тип', 'w:e:t')]);
      const second: Button[] = [btn('Даты', 'w:e:dt')];
      if (d.tripType === 'roundtrip') second.push(btn('Ночи', 'w:e:n'));
      second.push(btn('Фильтры', 'w:e:f'), btn('Цена', 'w:e:p'));
      rows.push(second, [btn('✖️ Отмена', 'w:x')]);
      return show(ctx, text, rows, { edit });
    }
  }
}

function firstMissing(d: Draft): Step {
  if (!d.origins.length) return 'origins';
  if (!d.destinations.length) return 'destinations';
  if (!d.tripType) return 'type';
  if (!d.departFrom || !d.departTo) return 'dates';
  if (d.tripType === 'roundtrip' && (d.nightsMin === null || d.nightsMax === null)) return 'nights';
  if (!d.priceMode || (d.priceMode !== 'auto' && d.maxPrice === null)) return 'price';
  return 'confirm';
}

async function goto(ctx: BotContext, step: Step, d: Draft, edit: boolean): Promise<void> {
  if (step === 'price' && !d.hintChecked) await computeHint(ctx, d);
  await save(ctx, step, d);
  await screen(ctx, step, d, edit);
}

/** Следующий шаг после завершения `step`. */
function nextStep(step: Step, d: Draft): Step {
  if (d.toConfirm) return firstMissing(d);
  switch (step) {
    case 'origins':
    case 'origins_pick':
      return 'destinations';
    case 'destinations':
    case 'destinations_pick':
      return 'type';
    case 'type':
      return 'dates';
    case 'dates':
      return d.tripType === 'roundtrip' ? 'nights' : 'filters';
    case 'nights':
      return 'filters';
    case 'filters':
    case 'weekdays':
    case 'return_to':
      return 'price';
    case 'price':
    case 'price_input':
      return 'confirm';
    case 'confirm':
      return 'confirm';
  }
}

function prevStep(step: Step, d: Draft): Step | null {
  if (d.toConfirm && !['weekdays', 'return_to', 'price_input', 'origins_pick', 'destinations_pick'].includes(step)) return 'confirm';
  switch (step) {
    case 'origins':
      return null;
    case 'origins_pick':
      return 'origins';
    case 'destinations':
      return 'origins';
    case 'destinations_pick':
      return 'destinations';
    case 'type':
      return 'destinations';
    case 'dates':
      return 'type';
    case 'nights':
      return 'dates';
    case 'filters':
      return d.tripType === 'roundtrip' ? 'nights' : 'dates';
    case 'weekdays':
    case 'return_to':
      return 'filters';
    case 'price':
      return 'filters';
    case 'price_input':
      return 'price';
    case 'confirm':
      return 'price';
  }
}

async function computeHint(ctx: BotContext, d: Draft): Promise<void> {
  d.hintChecked = true;
  d.hint = null;
  const spec = previewSpec(d);
  if (!spec) return;
  try {
    await ctx.replyWithChatAction('typing').catch(() => undefined);
    const p = await previewPrices(ctx.svc, spec, ctx.user, BUDGET.HINT_DEADLINE_MS);
    if (p?.best) {
      const o = p.best;
      d.hint = { price: o.price, line: `<b>${fmtPrice(o.price, ctx.user.currency)}</b> (${datesLine(o)}, ${o.originAirport}→${o.destAirport})` };
    }
  } catch (e) {
    ctx.svc.log.warn('price hint failed', { error: String((e as Error)?.message) });
  }
}

// ---------- Точки входа ----------

export async function startWizard(ctx: BotContext): Promise<void> {
  const active = await ctx.svc.repo.countActiveWatches(ctx.user.id);
  if (active >= BOT.MAX_ACTIVE_WATCHES) {
    await ctx.reply(`У тебя уже ${active} активных наблюдений — это максимум. Поставь какое-нибудь на паузу или удали в /list.`);
    return;
  }
  await goto(ctx, 'origins', newDraft(), false);
}

export async function startEdit(ctx: BotContext, watch: Watch): Promise<void> {
  const names = await ctx.svc.repo.getNames([...watch.origins, ...watch.destinations], []);
  await goto(ctx, 'confirm', draftFromWatch(watch, names), true);
}

export async function cancelWizard(ctx: BotContext, edit: boolean): Promise<void> {
  await ctx.svc.repo.clearWizard(ctx.user.tgUserId);
  await show(ctx, 'Отменил. /new — новое наблюдение, /list — список.', [], { edit });
}

// ---------- Текстовый ввод ----------

/** true — сообщение обработано мастером. */
export async function handleWizardText(ctx: BotContext, text: string): Promise<boolean> {
  const st = await loadWizard(ctx);
  if (!st) return false;
  const { step, draft: d } = st;
  const today = todayIn(ctx.svc.now(), ctx.user.tz);

  switch (step) {
    case 'origins':
    case 'destinations':
      await handlePlaces(ctx, step, d, text);
      return true;
    case 'dates': {
      const r = parseDateRange(text, today);
      if (!r.ok) {
        await ctx.reply(`⚠️ ${r.error}`);
        return true;
      }
      d.departFrom = r.value.from;
      d.departTo = r.value.to;
      d.hintChecked = false;
      if (r.value.clamped) await ctx.reply(`Начало окна уже прошло — считаю с сегодняшнего дня (${fmtDate(r.value.from, false)}).`);
      if (r.value.truncated) await ctx.reply(`Дальше чем на год вперёд у Aviasales цен нет — окно заканчивается ${fmtDate(r.value.to, false)}.`);
      await goto(ctx, nextStep('dates', d), d, false);
      return true;
    }
    case 'nights': {
      const r = parseNights(text);
      if (!r.ok) {
        await ctx.reply(`⚠️ ${r.error}`);
        return true;
      }
      d.nightsMin = r.value.min;
      d.nightsMax = r.value.max;
      d.hintChecked = false;
      await goto(ctx, nextStep('nights', d), d, false);
      return true;
    }
    case 'return_to': {
      const r = parseDateRange(text, today);
      if (!r.ok || r.value.from !== r.value.to) {
        await ctx.reply('⚠️ Нужна одна дата, например 10.12.');
        return true;
      }
      d.returnTo = r.value.to;
      d.hintChecked = false;
      await goto(ctx, 'filters', d, false);
      return true;
    }
    case 'price_input': {
      const r = parsePrice(text);
      if (!r.ok) {
        await ctx.reply(`⚠️ ${r.error}`);
        return true;
      }
      d.maxPrice = r.value;
      d.priceMode = d.pendingMode ?? 'threshold';
      d.pendingMode = null;
      await goto(ctx, 'confirm', d, false);
      return true;
    }
    default:
      await ctx.reply('Выбери вариант кнопкой в сообщении выше или /cancel, чтобы выйти из мастера.');
      return true;
  }
}

async function handlePlaces(ctx: BotContext, field: PlaceField, d: Draft, text: string): Promise<void> {
  const terms = text
    .split(/[,;\n]| и /)
    .map((t) => t.trim())
    .filter(Boolean);
  const max = field === 'origins' ? PLANNER.MAX_ORIGINS : PLANNER.MAX_DESTINATIONS;
  if (!terms.length) return void (await ctx.reply('Напиши город или код аэропорта.'));
  if (terms.length > max) return void (await ctx.reply(`Не больше ${max} пунктов за раз.`));

  const resolved: PlaceRef[] = [];
  const queue: Array<{ term: string; options: PlaceRef[] }> = [];
  const allPlaces: Place[] = [];
  for (const term of terms) {
    let places: Place[];
    try {
      places = await ctx.svc.searchPlaces(term);
    } catch (e) {
      ctx.svc.log.warn('autocomplete failed', { error: e instanceof ProviderError ? e.message : String(e) });
      return void (await ctx.reply('⚠️ Сервис поиска городов сейчас недоступен, попробуй через минуту.'));
    }
    allPlaces.push(...places);
    const choice = choosePlace(term, places, BOT.AUTOCOMPLETE_MAX_CHOICES);
    if (choice.kind === 'none') return void (await ctx.reply(`Не нашёл «${escapeHtml(term)}». Попробуй иначе, например код IATA (MOW, IST).`, { parse_mode: 'HTML' }));
    if (choice.kind === 'resolved') resolved.push(refOf(choice.place));
    else queue.push({ term, options: choice.options.map(refOf) });
  }
  if (allPlaces.length) await ctx.svc.repo.batch(ctx.svc.repo.stmtsUpsertPlaces(allPlaces, ctx.svc.now().toISOString()));

  if (queue.length) {
    d.pick = { field, queue, resolved };
    await goto(ctx, field === 'origins' ? 'origins_pick' : 'destinations_pick', d, false);
    return;
  }
  await applyPlaces(ctx, field, d, resolved, false);
}

function refOf(p: Place): PlaceRef {
  return { code: p.code, name: placeLabel(p) };
}

async function applyPlaces(ctx: BotContext, field: PlaceField, d: Draft, refs: PlaceRef[], edit: boolean): Promise<void> {
  const unique = [...new Map(refs.map((r) => [r.code, r])).values()];
  d[field] = unique.map((r) => ({ code: r.code, name: r.name.replace(/ \([A-Z0-9]{3}\).*$/, '') }));
  d.pick = null;
  d.hintChecked = false;
  const other = field === 'origins' ? d.destinations : d.origins;
  if (other.length && d[field].every((p) => other.some((o) => o.code === p.code))) {
    await ctx.reply('⚠️ Пункты вылета и назначения совпадают — укажи другие.');
    await goto(ctx, field, d, false);
    return;
  }
  const label = unique.map((r) => escapeHtml(r.name)).join(', ');
  if (!edit) await ctx.reply(`${field === 'origins' ? '🛫 Откуда' : '🛬 Куда'}: ${label}`, { parse_mode: 'HTML' });
  await goto(ctx, nextStep(field, d), d, edit);
}

// ---------- Кнопки ----------

export async function handleWizardCallback(ctx: BotContext, data: string): Promise<void> {
  const st = await loadWizard(ctx);
  if (!st) {
    await ack(ctx, 'Мастер устарел — начни заново: /new', true);
    return;
  }
  const { step, draft: d } = st;
  const [, action, arg] = data.split(':');
  await ack(ctx);

  switch (action) {
    case 'x':
      return cancelWizard(ctx, true);
    case 'b': {
      const prev = prevStep(step, d);
      if (!prev) return cancelWizard(ctx, true);
      return goto(ctx, prev, d, true);
    }
    case 'p': {
      if (!d.pick || !(step === 'origins_pick' || step === 'destinations_pick')) return;
      const cur = d.pick.queue.shift();
      const option = cur?.options[Number(arg)];
      if (!option) return;
      d.pick.resolved.push(option);
      if (d.pick.queue.length) return goto(ctx, step, d, true);
      return applyPlaces(ctx, d.pick.field, d, d.pick.resolved, true);
    }
    case 't': {
      d.tripType = arg === 'rt' ? 'roundtrip' : 'oneway';
      d.hintChecked = false;
      return goto(ctx, nextStep('type', d), d, true);
    }
    case 'n': {
      const r = parseNights(arg ?? '');
      if (!r.ok) return;
      d.nightsMin = r.value.min;
      d.nightsMax = r.value.max;
      d.hintChecked = false;
      return goto(ctx, nextStep('nights', d), d, true);
    }
    case 'f':
      return filtersAction(ctx, d, arg ?? '');
    case 'wd': {
      if (arg === 'ok') return goto(ctx, 'filters', d, true);
      if (arg === 'all') d.departWeekdays = [];
      else {
        const n = Number(arg);
        if (n >= 1 && n <= 7) d.departWeekdays = d.departWeekdays.includes(n) ? d.departWeekdays.filter((x) => x !== n) : [...d.departWeekdays, n];
      }
      d.hintChecked = false;
      return goto(ctx, 'weekdays', d, true);
    }
    case 'r':
      d.returnTo = null;
      d.hintChecked = false;
      return goto(ctx, 'filters', d, true);
    case 'pm': {
      const mode = arg as PriceMode;
      if (mode === 'auto') {
        d.priceMode = 'auto';
        d.maxPrice = null;
        return goto(ctx, 'confirm', d, true);
      }
      d.pendingMode = mode === 'both' ? 'both' : 'threshold';
      return goto(ctx, 'price_input', d, true);
    }
    case 'pv': {
      const v = Number(arg);
      if (!Number.isFinite(v) || v < 100) return;
      d.maxPrice = v;
      d.priceMode = d.pendingMode ?? 'threshold';
      d.pendingMode = null;
      return goto(ctx, 'confirm', d, true);
    }
    case 'e': {
      d.toConfirm = true;
      const map: Record<string, Step> = { o: 'origins', d: 'destinations', t: 'type', dt: 'dates', n: 'nights', f: 'filters', p: 'price' };
      const target = map[arg ?? ''];
      if (!target) return;
      return goto(ctx, target, d, true);
    }
    case 'ok':
      return commit(ctx, d);
  }
}

async function filtersAction(ctx: BotContext, d: Draft, arg: string): Promise<void> {
  switch (arg) {
    case 'd':
      d.directOnly = !d.directOnly;
      break;
    case 't':
      d.maxTransfers = d.maxTransfers === null ? 1 : d.maxTransfers === 1 ? 2 : null;
      break;
    case 'w':
      return goto(ctx, 'weekdays', d, true);
    case 'n':
      d.noNight = !d.noNight;
      break;
    case 'a':
      d.adults = d.adults >= 4 ? 1 : d.adults + 1;
      break;
    case 'r':
      return goto(ctx, 'return_to', d, true);
    case 'ok':
      return goto(ctx, nextStep('filters', d), d, true);
  }
  d.hintChecked = false;
  await goto(ctx, 'filters', d, true);
}

/** Создать или сохранить watch. */
async function commit(ctx: BotContext, d: Draft): Promise<void> {
  const { svc, user } = ctx;
  const spec = specFromDraft(d);
  if (!spec) return goto(ctx, firstMissing(d), d, true);
  const now = svc.now();
  const plan = planQueries(spec, todayIn(now, user.tz), { currency: user.currency, market: svc.cfg.market });
  if (!plan.ok) {
    await ctx.reply(`⚠️ ${plan.error.message}`);
    return goto(ctx, 'confirm', d, false);
  }
  const name = `${d.origins.map((p) => p.name).join(', ')} → ${d.destinations.map((p) => p.name).join(', ')}`.slice(0, 120);
  const nowIso = now.toISOString();

  if (d.editingWatchId) {
    const old = await svc.repo.getWatchForUser(user.id, d.editingWatchId);
    if (!old) {
      await svc.repo.clearWizard(user.tgUserId);
      return show(ctx, 'Это наблюдение уже удалено.', [], { edit: true });
    }
    const reset =
      JSON.stringify([old.origins, old.destinations, old.tripType, old.departFrom, old.departTo, old.nightsMin, old.nightsMax]) !==
      JSON.stringify([spec.origins, spec.destinations, spec.tripType, spec.departFrom, spec.departTo, spec.nightsMin, spec.nightsMax]);
    await svc.repo.updateWatchSpec(old.id, name, spec, nowIso, reset);
    // истёкшее с новыми датами оживает (если есть место); пауза остаётся паузой
    if (old.status === 'expired') {
      if ((await svc.repo.countActiveWatches(user.id)) < BOT.MAX_ACTIVE_WATCHES) await svc.repo.setWatchStatus(old.id, 'active', nowIso);
      else await svc.repo.setWatchStatus(old.id, 'paused', nowIso);
    }
    await svc.repo.clearWizard(user.tgUserId);
    await show(ctx, `💾 Наблюдение #${old.id} сохранено. Проверяю цены…`, [], { edit: true });
    svc.waitUntil(runInitialCheck(svc, old.id, user, 'manual'));
    return;
  }

  const active = await svc.repo.countActiveWatches(user.id);
  if (active >= BOT.MAX_ACTIVE_WATCHES) {
    return show(ctx, `Уже ${active} активных наблюдений — это максимум. Освободи место в /list.`, [], { edit: true });
  }
  const id = await svc.repo.createWatch(user.id, name, spec, nowIso, BOT.DEFAULT_CHECK_INTERVAL_MIN);
  await svc.repo.clearWizard(user.tgUserId);
  await show(ctx, `✅ Наблюдение #${id} создано: ${escapeHtml(name)}.\nПроверяю текущие цены — пришлю точку отсчёта…`, [], { edit: true });
  svc.waitUntil(runInitialCheck(svc, id, user, 'initial'));
}

export const _test = { nextStep, prevStep, firstMissing, fmtNumber };
