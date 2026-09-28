// Все пороги, лимиты и бюджеты — здесь. Значения покрыты тестами (test/core/*).

/** Детектор «дешёвой цены» (SPEC §6). */
export const DETECTOR = {
  /** Окно медианы daily_min, дней. */
  BASELINE_WINDOW_DAYS: 21,
  /** Минимум дней истории для «надёжной» медианы. */
  BASELINE_MIN_DAYS: 5,
  /** Минимум дней истории для сработки «новый рекорд». */
  RECORD_MIN_DAYS: 7,
  /** Во сколько раз требовать бо́льшую скидку при low-confidence (холодный старт). */
  LOW_CONFIDENCE_MULTIPLIER: 1.5,
  /** Чувствительность авто-режима по умолчанию (−20%). */
  DEFAULT_SENSITIVITY: 0.2,
} as const;

/** Анти-спам (SPEC §7). */
export const NOTIFY = {
  /** Повтор по тому же offer_key — только если цена упала на ≥ 5% ... */
  REALERT_MIN_DROP_PCT: 0.05,
  /** ... и на ≥ 300 в валюте пользователя (для RUB; для прочих валют — см. REALERT_MIN_DROP_ABS_BY_CURRENCY). */
  REALERT_MIN_DROP_ABS: 300,
  REALERT_MIN_DROP_ABS_BY_CURRENCY: { rub: 300, usd: 4, eur: 4, kzt: 1500, uah: 150, byn: 10, try: 120 } as Record<string, number>,
  /** Сколько вариантов показывать в уведомлении. */
  TOP_N: 3,
  /** Сколько вариантов показывать по кнопке «Показать все». */
  SHOW_ALL_N: 10,
  /** Цена ниже max_price на ≥ 30% — отправлять даже в тихие часы (без звука). */
  URGENT_BELOW_MAX_PCT: 0.3,
  /** Отложенные уведомления старше этого срока в дайджест не попадают (цены из кэша успевают устареть). */
  DIGEST_MAX_AGE_HOURS: 36,
  /** Максимум вариантов в дайджесте. */
  DIGEST_MAX_OFFERS: 10,
  /** Сколько раз пытаться отправить сообщение, прежде чем выбросить. */
  MAX_SEND_ATTEMPTS: 5,
  /** Ждать retry_after от Telegram прямо в вызове, если он не больше N секунд. */
  MAX_INLINE_RETRY_AFTER_SEC: 3,
  /** Сколько ошибок подряд по watch, прежде чем сообщить пользователю. */
  WATCH_ERRORS_BEFORE_NOTICE: 10,
} as const;

/** Фильтры (SPEC §5.3). */
export const FILTERS = {
  /** Вылет не раньше чем через N часов от «сейчас». */
  MIN_HOURS_BEFORE_DEPARTURE: 3,
  /** «Без ночных вылетов»: разрешённое окно локального времени вылета. */
  NO_NIGHT_FROM: '06:00',
  NO_NIGHT_TO: '23:00',
} as const;

/** Планировщик запросов (SPEC §5.2). */
export const PLANNER = {
  /** Больше N запросов на один watch — отказ при создании. */
  MAX_QUERIES_PER_WATCH: 24,
  /** Окна вылета не длиннее N дней можно разворачивать в запросы на конкретные дни. */
  DAY_QUERY_MAX_WINDOW_DAYS: 3,
  /** Как далеко вперёд можно смотреть (у Aviasales нет данных дальше ~года). */
  MAX_DAYS_AHEAD: 366,
  /** Оценочный объём ответов одного watch за проверку (CPU на Workers ≈ 2 мс на 150 КБ). */
  MAX_EST_BYTES_PER_WATCH: 900_000,
  MAX_ORIGINS: 5,
  MAX_DESTINATIONS: 5,
  MAX_NIGHTS: 60,
} as const;

/** Провайдер Travelpayouts (SPEC §5). */
export const PROVIDER = {
  /** Размер страницы prices_for_dates. Документированный максимум — 1000, но при 10 мс CPU на вызов
   *  парсинг сотен КБ JSON × десятки запросов не укладывается; сортировка по цене + догрузка страниц
   *  дают тот же результат. См. docs/DECISIONS.md. */
  PAGE_LIMIT: 200,
  /** API отдаёт чуть меньше limit даже на неполных страницах (проверено: 192 из 200, затем ещё 184).
   *  Последней считаем страницу, где записей меньше этой доли от limit. */
  PAGE_FULL_RATIO: 0.75,
  /** Максимум страниц на один запрос за проверку. */
  MAX_PAGES: 3,
  /** Таймаут запроса, мс. */
  TIMEOUT_MS: 8000,
  /** Параллельность запросов (лимит Workers — 6 одновременных соединений). */
  CONCURRENCY: 6,
  /** TTL кэша ответов между тиками, мин. */
  CACHE_TTL_MIN: 30,
  /** Сколько самых дешёвых офферов хранить в кэше на один запрос. */
  CACHE_MAX_OFFERS: 300,
  /** Экспоненциальный backoff при 429: первый шаг и потолок, мин. */
  BACKOFF_START_MIN: 2,
  BACKOFF_MAX_MIN: 120,
  /** Бутстрап истории (grouped_prices) — максимум запросов на один watch. */
  BOOTSTRAP_MAX_QUERIES: 6,
  /** Сколько месяцев вокруг окна брать для бутстрапа. */
  BOOTSTRAP_NEIGHBOR_MONTHS: 1,
  /** Минимум точек календаря для бутстрап-медианы. */
  BOOTSTRAP_MIN_POINTS: 3,
  DEFAULT_MARKET: 'ru',
} as const;

/**
 * Бюджет subrequests на один вызов Worker (Free: 50, и по документации D1 — те же 50 запросов к БД).
 * Внешние fetch и вызовы D1 считаются вместе, D1 — батчами.
 */
export const BUDGET = {
  TOTAL_SUBREQUESTS: 50,
  /** Запросы к Travelpayouts за тик (ТЗ: ≤ 30; снижено до 24 = максимум одного watch, т.к. D1 тоже в лимите). */
  TICK_API_REQUESTS: 24,
  /** Сообщений в Telegram за тик (остальное — следующим тиком). */
  TICK_TG_MESSAGES: 8,
  /** Запросов к API при ручной проверке / после создания. */
  MANUAL_API_REQUESTS: 24,
  /** Оценочный объём JSON на тик (защита от 10 мс CPU). Замер на Workers: ~2 мс CPU на страницу 150 КБ
   *  (разбор + фильтры + кэш) плюс холодный старт ~4–10 мс. 450 КБ ≈ 3 помесячные страницы. */
  TICK_MAX_RESPONSE_BYTES: 450_000,
  /** Во сколько раз урезать объём после прерванного тика (и как быстро восстанавливать). */
  ABORT_BUDGET_FACTOR_MIN: 0.25,
  ABORT_BUDGET_RECOVERY: 1.25,
  /** Сколько subrequests держать в запасе на запись в D1 и отправку сообщений. */
  RESERVE_FOR_WRITES: 4,
  /** Дедлайн на сетевую часть проверки из вебхука (waitUntil живёт ≤ 30 с). */
  MANUAL_DEADLINE_MS: 20_000,
  /** Дедлайн подсказки цены в мастере. */
  HINT_DEADLINE_MS: 8_000,
} as const;

/** Хранение (SPEC §4). */
export const RETENTION = {
  OBSERVATIONS_DAYS: 60,
  DAILY_MIN_DAYS: 365,
  OUTBOX_DAYS: 14,
  COUNTERS_DAYS: 120,
  API_CACHE_HOURS: 24,
  /** Сколько самых дешёвых подходящих офферов сохранять в observations за одну проверку. */
  OBSERVATIONS_PER_CHECK: 10,
  /** Порция удаления за один запрос. */
  DELETE_CHUNK: 5000,
} as const;

/** Бот (SPEC §8). */
export const BOT = {
  MAX_ACTIVE_WATCHES: 20,
  WIZARD_TTL_MIN: 30,
  MANUAL_CHECK_COOLDOWN_MIN: 5,
  DEFAULT_TZ: 'Europe/Moscow',
  DEFAULT_DAILY_CAP: 20,
  DEFAULT_CHECK_INTERVAL_MIN: 60,
  MAX_ADULTS: 9,
  /** Не чаще раза в N минут слать админу одинаковые системные ошибки. */
  ADMIN_ALERT_COOLDOWN_MIN: 360,
  AUTOCOMPLETE_MAX_CHOICES: 6,
} as const;

export const AVIASALES_HOST = 'https://www.aviasales.ru';

/** Название продукта в системных сообщениях (в приветствии — имя бота из BotFather). */
export const APP_NAME = 'FlightTracker';
