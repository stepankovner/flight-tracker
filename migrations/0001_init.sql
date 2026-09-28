-- FareWatch: начальная схема (SPEC.md §4 + служебные таблицы, см. docs/DECISIONS.md)

CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  tg_user_id       INTEGER NOT NULL UNIQUE,
  chat_id          INTEGER NOT NULL,
  username         TEXT,                          -- текущий username (lowercase, без @)
  bound_username   TEXT,                          -- username на момент привязки (для allowlist после смены)
  tz               TEXT NOT NULL DEFAULT 'Europe/Moscow',
  currency         TEXT NOT NULL DEFAULT 'rub',
  quiet_from       TEXT,                          -- 'HH:MM'
  quiet_to         TEXT,                          -- 'HH:MM'
  daily_alert_cap  INTEGER NOT NULL DEFAULT 20,
  is_blocked       INTEGER NOT NULL DEFAULT 0,    -- пользователь заблокировал бота (403)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE watches (
  id                   INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('active','paused','expired','deleted')),
  origins              TEXT NOT NULL,             -- JSON ["MOW"]
  destinations         TEXT NOT NULL,             -- JSON ["IST"]
  trip_type            TEXT NOT NULL CHECK (trip_type IN ('oneway','roundtrip')),
  depart_from          TEXT NOT NULL,             -- YYYY-MM-DD
  depart_to            TEXT NOT NULL,             -- YYYY-MM-DD
  nights_min           INTEGER,
  nights_max           INTEGER,
  return_to            TEXT,
  depart_weekdays      TEXT,                      -- JSON [1..7], 1 = пн
  return_weekdays      TEXT,
  direct_only          INTEGER NOT NULL DEFAULT 0,
  max_transfers        INTEGER,
  max_duration_min     INTEGER,
  exclude_airlines     TEXT,                      -- JSON ["SU"]
  depart_time_from     TEXT,                      -- 'HH:MM', локальное время вылета
  depart_time_to       TEXT,
  adults               INTEGER NOT NULL DEFAULT 1,
  price_mode           TEXT NOT NULL CHECK (price_mode IN ('threshold','auto','both')),
  max_price            INTEGER,
  auto_sensitivity     REAL NOT NULL DEFAULT 0.20,
  check_interval_min   INTEGER NOT NULL DEFAULT 60,
  last_checked_at      TEXT,
  last_error           TEXT,
  error_count          INTEGER NOT NULL DEFAULT 0,
  -- служебные поля (не из ТЗ)
  bootstrap_baseline   INTEGER,                   -- медиана календаря цен при холодном старте
  bootstrap_at         TEXT,
  last_min_price       INTEGER,                   -- лучшая цена последней проверки (для /list)
  last_min_offer       TEXT,                      -- JSON Offer
  last_manual_check_at TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_watches_user ON watches(user_id, status);
CREATE INDEX idx_watches_due ON watches(status, last_checked_at);

CREATE TABLE observations (
  id                  INTEGER PRIMARY KEY,
  watch_id            INTEGER NOT NULL REFERENCES watches(id),
  observed_at         TEXT NOT NULL,
  origin_airport      TEXT NOT NULL,
  destination_airport TEXT NOT NULL,
  depart_date         TEXT NOT NULL,
  return_date         TEXT,
  price               INTEGER NOT NULL,
  airline             TEXT,
  flight_number       TEXT,
  transfers           INTEGER,
  duration_min        INTEGER,
  link                TEXT,
  source_found_at     TEXT
);
-- Второй индекс из ТЗ (watch_id, depart_date, return_date) не создаём: ни один запрос его не использует,
-- а каждый индекс удваивает «rows written» (лимит D1 Free — 100k/сутки).
CREATE INDEX idx_observations_watch_time ON observations(watch_id, observed_at);

CREATE TABLE daily_min (
  watch_id  INTEGER NOT NULL REFERENCES watches(id),
  day       TEXT NOT NULL,                        -- YYYY-MM-DD (UTC)
  min_price INTEGER NOT NULL,
  PRIMARY KEY (watch_id, day)
);

CREATE TABLE notified (
  watch_id     INTEGER NOT NULL REFERENCES watches(id),
  offer_key    TEXT NOT NULL,
  last_price   INTEGER NOT NULL,
  last_sent_at TEXT NOT NULL,
  times_sent   INTEGER NOT NULL DEFAULT 1,
  muted        INTEGER NOT NULL DEFAULT 0,        -- «Не показывать этот рейс»
  depart_date  TEXT NOT NULL,                     -- для ретеншна
  PRIMARY KEY (watch_id, offer_key)
);

CREATE TABLE api_cache (
  cache_key  TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,                       -- JSON нормализованных офферов
  fetched_at TEXT NOT NULL
);

CREATE TABLE wizard_state (
  tg_user_id INTEGER PRIMARY KEY,
  step       TEXT NOT NULL,
  draft      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Очередь исходящих уведомлений: тихие часы, дневной лимит, ретраи, «Показать все».
CREATE TABLE outbox (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  watch_id       INTEGER REFERENCES watches(id),
  kind           TEXT NOT NULL CHECK (kind IN ('alert','reply','system','digest','cap_notice')),
  payload        TEXT NOT NULL,
  urgent         INTEGER NOT NULL DEFAULT 0,      -- ниже max_price на ≥30%: слать и в тихие часы (без звука)
  status         TEXT NOT NULL CHECK (status IN ('pending','sent','dropped')),
  deferred       TEXT,                            -- 'quiet' | 'cap' — уйдёт дайджестом
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  sent_at        TEXT,
  tg_message_id  INTEGER
);
CREATE INDEX idx_outbox_pending ON outbox(status, user_id);
CREATE INDEX idx_outbox_user_sent ON outbox(user_id, sent_at);

-- Глобальное состояние: rate_limited_until, backoff, анти-флуд админских сообщений и т.п.
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Суточные счётчики (UTC): запросы к API, ошибки, отправленные сообщения.
CREATE TABLE counters (
  day   TEXT NOT NULL,
  name  TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);

-- Справочники для красивых названий (заполняются лениво).
CREATE TABLE places (
  code         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                     -- 'city' | 'airport'
  name         TEXT NOT NULL,
  city_code    TEXT,
  city_name    TEXT,
  country_name TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE airlines (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
