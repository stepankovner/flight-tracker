import type { CalendarQuery } from '../core/queryPlanner.ts';
import type { FareQuery, IsoDate, Offer } from '../core/types.ts';

export interface SearchPage {
  offers: Offer[];
  /** Сколько записей вернул провайдер (до нормализации) — для решения о следующей странице. */
  rawCount: number;
  /** Размер тела ответа в байтах (для CPU-бюджета тика). */
  bytes: number;
}

export interface CalendarPoint {
  departDate: IsoDate;
  price: number;
}

/**
 * Источник цен. Сейчас один — Travelpayouts Data API; интерфейс оставлен, чтобы добавить другие
 * без переписывания логики (SPEC §1.4).
 */
export interface FareProvider {
  readonly id: string;
  /** Самые дешёвые билеты на даты/месяцы, отсортированные по цене. */
  search(query: FareQuery, page: number, limit: number): Promise<SearchPage>;
  /** Минимальная цена по каждой дате вылета месяца (для бутстрапа истории). */
  calendar(query: CalendarQuery): Promise<CalendarPoint[]>;
}

export type ProviderErrorKind = 'auth' | 'rate_limit' | 'server' | 'timeout' | 'network' | 'bad_response' | 'client';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  /** Для rate_limit: через сколько секунд можно повторить (из заголовков), если известно. */
  readonly retryAfterSec: number | null;

  constructor(kind: ProviderErrorKind, message: string, status: number | null = null, retryAfterSec: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }

  /** Имеет смысл повторить запрос сразу (5xx / таймаут / сеть). */
  get retryable(): boolean {
    return this.kind === 'server' || this.kind === 'timeout' || this.kind === 'network';
  }
}
