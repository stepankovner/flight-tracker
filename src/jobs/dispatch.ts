import { NOTIFY } from '../config.ts';
import {
  EMPTY_NAMES,
  renderAlert,
  renderDigest,
  type AlertPayload,
  type DigestItem,
  type Keyboard,
  type NameBook,
} from '../core/format.ts';
import { canSendDigest, decideAlertDelivery, isStale, systemSilent, userDayStart } from '../core/notifyPolicy.ts';
import type { User } from '../core/types.ts';
import type { OutboxRow, Repo } from '../db/repo.ts';
import type { SqlStatement } from '../db/sql.ts';
import type { Budget } from '../platform/budget.ts';
import type { Logger } from '../platform/log.ts';
import type { Messenger, SendResult } from '../platform/telegram.ts';

export interface DispatchDeps {
  repo: Repo;
  messenger: Messenger;
  budget: Budget;
  log: Logger;
  now: Date;
  marker: string | null;
}

export interface DispatchOptions {
  /** Максимум сообщений за вызов. */
  maxMessages: number;
  /** Только для одного пользователя (после ручной проверки). */
  userId?: number;
  /** Сколько subrequests оставить в запасе (на финальную запись). */
  reserveSubrequests?: number;
}

export interface DispatchReport {
  sent: number;
  deferred: number;
  dropped: number;
  failed: number;
  floodWaitSec: number | null;
}

/** Простой текстовый payload для system/reply-сообщений. */
export interface TextPayload {
  text: string;
  keyboard?: Keyboard;
}

function isAlertPayload(p: unknown): p is AlertPayload {
  return typeof p === 'object' && p !== null && (p as AlertPayload).v === 1 && Array.isArray((p as AlertPayload).offers);
}

function parsePayload(row: OutboxRow): AlertPayload | TextPayload | null {
  try {
    return JSON.parse(row.payload) as AlertPayload | TextPayload;
  } catch {
    return null;
  }
}

function codesOf(payloads: unknown[]): { places: string[]; airlines: string[] } {
  const places: string[] = [];
  const airlines: string[] = [];
  for (const p of payloads) {
    if (!isAlertPayload(p)) continue;
    places.push(...p.origins, ...p.destinations);
    for (const a of p.offers) {
      places.push(a.offer.originAirport, a.offer.destAirport);
      airlines.push(a.offer.airline);
    }
  }
  return { places, airlines };
}

/**
 * Отправляет очередь outbox с учётом тихих часов, дневного лимита и дайджестов (SPEC §7).
 * Идемпотентно: каждое сообщение отмечается в outbox; ошибки Telegram не теряют уведомление.
 */
export async function dispatchOutbox(deps: DispatchDeps, opts: DispatchOptions): Promise<DispatchReport> {
  const { repo, messenger, budget, log, now } = deps;
  const nowIso = now.toISOString();
  const report: DispatchReport = { sent: 0, deferred: 0, dropped: 0, failed: 0, floodWaitSec: null };
  const reserve = opts.reserveSubrequests ?? 1;

  const since = new Date(now.getTime() - 26 * 3_600_000).toISOString();
  const { pending, recentSent, users } = await repo.outboxForDispatch(since, opts.userId ?? null);
  if (pending.length === 0) return report;

  const parsed = new Map<number, AlertPayload | TextPayload | null>(pending.map((r) => [r.id, parsePayload(r)]));
  const codes = codesOf([...parsed.values()]);
  let names: NameBook = EMPTY_NAMES;
  if (codes.places.length || codes.airlines.length) {
    names = await repo.getNames(codes.places, codes.airlines);
  }

  const writes: SqlStatement[] = [];
  const byUser = new Map<number, OutboxRow[]>();
  for (const r of pending) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, []);
    byUser.get(r.userId)!.push(r);
  }

  const canSend = () =>
    report.floodWaitSec === null && report.sent < opts.maxMessages && budget.remaining() > reserve + 1;

  /** Обработать результат отправки; true — можно продолжать с этим пользователем. */
  const handle = (items: OutboxRow[], res: SendResult, user: User): boolean => {
    if (res.ok) {
      for (const it of items) writes.push(repo.stmtOutboxSent(it.id, nowIso, res.messageId));
      report.sent++;
      writes.push(repo.stmtIncr(nowIso.slice(0, 10), 'tg_sent', 1));
      return true;
    }
    writes.push(repo.stmtIncr(nowIso.slice(0, 10), 'tg_errors', 1));
    switch (res.kind) {
      case 'retry_after':
        report.floodWaitSec = res.retryAfterSec;
        return false;
      case 'blocked':
        log.warn('user blocked the bot', { userId: user.id });
        writes.push(repo.stmtSetUserBlocked(user.id, true, nowIso));
        for (const it of byUser.get(user.id) ?? []) writes.push(repo.stmtOutboxDropped(it.id, nowIso));
        report.dropped += byUser.get(user.id)?.length ?? 0;
        return false;
      case 'bad_request':
        log.error('telegram rejected message', { ids: items.map((i) => i.id), error: res.description });
        for (const it of items) writes.push(repo.stmtOutboxDropped(it.id, nowIso));
        report.dropped += items.length;
        return true;
      case 'transient':
        report.failed++;
        for (const it of items) {
          if (it.attempts + 1 >= NOTIFY.MAX_SEND_ATTEMPTS) writes.push(repo.stmtOutboxDropped(it.id, nowIso));
          else writes.push(repo.stmtOutboxAttempt(it.id));
        }
        return true;
    }
  };

  for (const [userId, items] of byUser) {
    const user = users.get(userId);
    if (!user) continue;
    if (user.isBlocked) {
      for (const it of items) writes.push(repo.stmtOutboxDropped(it.id, nowIso));
      report.dropped += items.length;
      continue;
    }
    const dayStart = userDayStart(now, user.tz).toISOString();
    const todays = recentSent.filter((r) => r.userId === userId && (r.sentAt ?? '') >= dayStart);
    // алерты, ушедшие в составе дайджеста (deferred != null), считаются одним сообщением-дайджестом
    let sentToday = todays.filter((r) => (r.kind === 'alert' && !r.deferred) || r.kind === 'digest').length;
    let capNoticeSent = todays.some((r) => r.kind === 'cap_notice');
    const silentNow = systemSilent(now, user);
    const digestCandidates: OutboxRow[] = [];
    let continueUser = true;

    for (const it of items) {
      if (!continueUser) break;
      const payload = parsed.get(it.id);
      if (!payload) {
        writes.push(repo.stmtOutboxDropped(it.id, nowIso));
        report.dropped++;
        continue;
      }

      if (it.kind === 'reply' || it.kind === 'system') {
        if (!canSend()) break;
        const r = isAlertPayload(payload)
          ? renderAlert(payload, { names, now, marker: deps.marker, outboxId: it.id })
          : { text: payload.text, keyboard: payload.keyboard ?? [] };
        const res = await messenger.send(user.chatId, r.text, { keyboard: r.keyboard, silent: it.kind === 'system' && silentNow });
        continueUser = handle([it], res, user);
        continue;
      }

      if (it.kind !== 'alert' || !isAlertPayload(payload)) {
        writes.push(repo.stmtOutboxDropped(it.id, nowIso));
        report.dropped++;
        continue;
      }

      if (it.deferred) {
        if (isStale(it.createdAt, now)) {
          writes.push(repo.stmtOutboxDropped(it.id, nowIso));
          report.dropped++;
        } else {
          digestCandidates.push(it);
        }
        continue;
      }

      const decision = decideAlertDelivery(it.urgent, { now, user, sentToday });
      if (decision.action === 'defer') {
        writes.push(repo.stmtOutboxDeferred(it.id, decision.reason));
        report.deferred++;
        if (decision.reason === 'cap' && !capNoticeSent && canSend()) {
          const text =
            `⚠️ Дневной лимит уведомлений (${user.dailyAlertCap}) исчерпан. ` +
            'Остальное пришлю одним дайджестом завтра. Лимит меняется в /settings.';
          const res = await messenger.send(user.chatId, text, { silent: silentNow });
          if (res.ok) {
            writes.push(repo.stmtInsertSent({ userId, watchId: null, kind: 'cap_notice', payload: { text }, now: nowIso, messageId: res.messageId }));
            report.sent++;
          }
          capNoticeSent = true;
        }
        continue;
      }
      if (!canSend()) break;
      const r = renderAlert(payload, { names, now, marker: deps.marker, outboxId: it.id });
      const res = await messenger.send(user.chatId, r.text, { keyboard: r.keyboard, silent: decision.silent });
      continueUser = handle([it], res, user);
      if (res.ok) sentToday++;
    }

    // дайджест отложенного — одним сообщением, когда тихие часы закончились и лимит позволяет
    if (continueUser && digestCandidates.length && canSend() && canSendDigest({ now, user, sentToday })) {
      const digestItems: DigestItem[] = digestCandidates.map((it) => ({
        outboxId: it.id,
        createdAt: it.createdAt,
        payload: parsed.get(it.id) as AlertPayload,
      }));
      const r = renderDigest(digestItems, { names, now, marker: deps.marker, tz: user.tz, maxOffers: NOTIFY.DIGEST_MAX_OFFERS });
      const res = await messenger.send(user.chatId, r.text, { keyboard: r.keyboard });
      handle(digestCandidates, res, user);
      if (res.ok) {
        writes.push(repo.stmtInsertSent({ userId, watchId: null, kind: 'digest', payload: { items: digestCandidates.map((d) => d.id) }, now: nowIso, messageId: res.messageId }));
      }
    }
  }

  if (writes.length) await repo.batch(writes);
  return report;
}
