import { PROVIDER } from '../config.ts';
import { todayIn } from '../core/dates.ts';
import { selectMatching } from '../core/filters.ts';
import { planQueries, queryKey } from '../core/queryPlanner.ts';
import type { Offer, User, WatchSpec } from '../core/types.ts';
import type { SqlStatement } from '../db/sql.ts';
import type { Services } from '../services.ts';
import { decodeCache, encodeCache, isLastPage, mapLimit } from './checker.ts';

export interface Preview {
  best: Offer | null;
  matching: number;
  /** Все ли запросы удалось выполнить. */
  complete: boolean;
}

/**
 * Текущая минимальная цена для черновика watch (подсказка в мастере, SPEC §8.3 шаг 7).
 * Результаты кладутся в api_cache — первая проверка после создания их переиспользует.
 */
export async function previewPrices(svc: Services, spec: WatchSpec, user: User, deadlineMs: number): Promise<Preview | null> {
  const now = svc.now();
  const plan = planQueries(spec, todayIn(now, user.tz), { currency: user.currency, market: svc.cfg.market });
  if (!plan.ok) return null;
  const queries = plan.value;
  const keys = queries.map(queryKey);
  const minFetched = new Date(now.getTime() - PROVIDER.CACHE_TTL_MIN * 60_000).toISOString();
  const cached = await svc.repo.getCache(keys, minFetched);
  const offers: Offer[] = [];
  let complete = true;
  const writes: SqlStatement[] = [];
  const deadline = Date.now() + deadlineMs;

  const missing = queries.filter((q, i) => {
    const hit = decodeCache(cached.get(keys[i]!));
    if (hit) offers.push(...hit.offers);
    return !hit;
  });
  const uniqueMissing = [...new Map(missing.map((q) => [queryKey(q), q])).values()];
  await mapLimit(uniqueMissing, PROVIDER.CONCURRENCY, async (q) => {
    if (Date.now() > deadline || svc.budget.remaining() < 4) {
      complete = false;
      return;
    }
    try {
      const res = await svc.provider.search(q, 1, PROVIDER.PAGE_LIMIT);
      offers.push(...res.offers);
      writes.push(svc.repo.stmtPutCache(queryKey(q), encodeCache(res.offers, 1, isLastPage(res.rawCount)), now.toISOString()));
    } catch (e) {
      complete = false;
      svc.log.warn('preview query failed', { error: String((e as Error)?.message) });
    }
  });
  if (writes.length) await svc.repo.batch([...writes, svc.repo.stmtIncr(now.toISOString().slice(0, 10), 'api_requests', writes.length)]);
  const matching = selectMatching(offers, spec, now);
  return { best: matching[0] ?? null, matching: matching.length, complete };
}
