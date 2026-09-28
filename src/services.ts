import { Repo } from './db/repo.ts';
import type { SqlDatabase } from './db/sql.ts';
import { Budget } from './platform/budget.ts';
import type { AppConfig, ExecCtx } from './platform/env.ts';
import { consoleLogger, type Logger } from './platform/log.ts';
import { TelegramMessenger, type Messenger } from './platform/telegram.ts';
import { searchPlaces, type Place } from './providers/autocomplete.ts';
import type { FareProvider } from './providers/FareProvider.ts';
import { TravelpayoutsProvider } from './providers/travelpayouts.ts';

/** Всё, что нужно обработчикам и задачам в рамках одного вызова Worker. */
export interface Services {
  cfg: AppConfig;
  repo: Repo;
  provider: FareProvider;
  messenger: Messenger;
  searchPlaces(term: string): Promise<Place[]>;
  budget: Budget;
  /** fetch с учётом бюджета subrequests (для grammY и прочего). */
  fetch: typeof fetch;
  log: Logger;
  now(): Date;
  waitUntil(p: Promise<unknown>): void;
}

export interface ServiceOverrides {
  provider?: FareProvider;
  messenger?: Messenger;
  searchPlaces?: (term: string) => Promise<Place[]>;
  fetch?: typeof fetch;
  log?: Logger;
  now?: () => Date;
}

export function createServices(cfg: AppConfig, db: SqlDatabase, ctx: ExecCtx, o: ServiceOverrides = {}): Services {
  const repo = new Repo(db);
  const budget = new Budget(() => repo.calls);
  const fetchImpl = budget.wrapFetch(o.fetch);
  const log = o.log ?? consoleLogger;
  return {
    cfg,
    repo,
    budget,
    fetch: fetchImpl,
    log,
    now: o.now ?? (() => new Date()),
    provider: o.provider ?? new TravelpayoutsProvider({ token: cfg.tpToken, fetch: fetchImpl }),
    messenger: o.messenger ?? new TelegramMessenger({ token: cfg.botToken, fetch: fetchImpl, log, dryRun: cfg.dryRun }),
    searchPlaces: o.searchPlaces ?? ((term) => searchPlaces(term, { fetch: fetchImpl })),
    waitUntil: (p) =>
      ctx.waitUntil(
        p.catch((e) => {
          log.error('background task failed', { error: String((e as Error)?.stack ?? e) });
        }),
      ),
  };
}
