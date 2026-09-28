import { BUDGET } from '../config.ts';

/**
 * Учёт subrequests в рамках одного вызова Worker (лимит Free — 50, D1 тоже считается).
 * Внешние fetch считаются через countingFetch, обращения к D1 — через Repo.calls.
 */
export class Budget {
  external = 0;
  apiRequests = 0;
  responseBytes = 0;
  private readonly total: number;
  private readonly dbCalls: () => number;

  constructor(dbCalls: () => number, total: number = BUDGET.TOTAL_SUBREQUESTS) {
    this.dbCalls = dbCalls;
    this.total = total;
  }

  get used(): number {
    return this.external + this.dbCalls();
  }

  remaining(): number {
    return this.total - this.used;
  }

  /** fetch, который считает каждый вызов. */
  wrapFetch(base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
    return (input, init) => {
      this.external++;
      return base(input, init);
    };
  }
}
