/** YYYY-MM-DD */
export type IsoDate = string;
/** YYYY-MM */
export type YearMonth = string;

export type TripType = 'oneway' | 'roundtrip';
export type PriceMode = 'threshold' | 'auto' | 'both';
export type WatchStatus = 'active' | 'paused' | 'expired' | 'deleted';

/** Параметры наблюдения, которые нужны чистой логике (планировщик, фильтры, детектор). */
export interface WatchSpec {
  origins: string[];
  destinations: string[];
  tripType: TripType;
  departFrom: IsoDate;
  departTo: IsoDate;
  nightsMin: number | null;
  nightsMax: number | null;
  returnTo: IsoDate | null;
  /** 1 = понедельник … 7 = воскресенье */
  departWeekdays: number[] | null;
  returnWeekdays: number[] | null;
  directOnly: boolean;
  maxTransfers: number | null;
  maxDurationMin: number | null;
  excludeAirlines: string[] | null;
  /** 'HH:MM', локальное время вылета в аэропорту отправления */
  departTimeFrom: string | null;
  departTimeTo: string | null;
  adults: number;
  priceMode: PriceMode;
  /** За 1 взрослого, в валюте пользователя */
  maxPrice: number | null;
  autoSensitivity: number;
}

export interface Watch extends WatchSpec {
  id: number;
  userId: number;
  name: string;
  status: WatchStatus;
  checkIntervalMin: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  errorCount: number;
  bootstrapBaseline: number | null;
  bootstrapAt: string | null;
  lastMinPrice: number | null;
  lastMinOffer: Offer | null;
  lastManualCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: number;
  tgUserId: number;
  chatId: number;
  username: string | null;
  boundUsername: string | null;
  tz: string;
  currency: string;
  quietFrom: string | null;
  quietTo: string | null;
  dailyAlertCap: number;
  isBlocked: boolean;
}

/** Нормализованный билет от провайдера. */
export interface Offer {
  originAirport: string;
  destAirport: string;
  /** ISO 8601 с offset — локальное время аэропорта вылета */
  departAt: string;
  returnAt: string | null;
  /** За 1 взрослого */
  price: number;
  currency: string;
  airline: string;
  flightNumber: string;
  transfersOut: number;
  transfersBack: number | null;
  durationMin: number | null;
  durationOutMin: number | null;
  durationBackMin: number | null;
  /** Относительный путь /search/... (может быть пустым) */
  link: string;
  /** Когда цена найдена (ISO) — если провайдер отдаёт */
  foundAt: string | null;
  expiresAt: string | null;
}

/** Запрос к провайдеру — результат QueryPlanner. */
export interface FareQuery {
  origin: string;
  destination: string;
  /** YYYY-MM или YYYY-MM-DD */
  departureAt: string;
  /** YYYY-MM или YYYY-MM-DD; null для oneway */
  returnAt: string | null;
  oneWay: boolean;
  direct: boolean;
  currency: string;
  market: string;
}

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E = string>(error: E): Result<never, E> => ({ ok: false, error });
