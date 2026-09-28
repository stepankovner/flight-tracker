# ТЗ: Telegram-бот мониторинга дешёвых авиабилетов («FareWatch»)

> Документ для Claude Code. Положи его в корень репозитория как `SPEC.md`, а в `CLAUDE.md` напиши: «Реализуй проект строго по SPEC.md, этап за этапом. Перед реализацией каждого внешнего API сверься с актуальной документацией и сообщи о расхождениях».

---

## 0. Цель

Пользователь через Telegram-бота создаёт «наблюдения» (watch): откуда, куда, гибкий диапазон дат, длительность поездки, фильтры, ценовой порог (или авто-режим). Сервис по расписанию опрашивает официальный API цен Aviasales (Travelpayouts), находит билеты дешевле порога или аномально дешёвые относительно истории и присылает в Telegram сообщение: маршрут, цена, даты, пересадки, ссылка на покупку.

Требования: работает 24/7, хостинг **бесплатный**, деплой одной командой, данные переживают перезапуски.

---

## 1. Критичные ограничения (прочитать до начала)

1. **Telegram не позволяет боту написать пользователю по username.** Бот может писать только тем, кто нажал `/start`. Решение: username задаётся в allowlist (`ALLOWED_USERNAMES`), при `/start` бот сверяет `from.username` и сохраняет `chat_id`. Уведомления идут по `chat_id`.
2. **Парсинг сайта aviasales.ru запрещён и нестабилен** (антибот, ToS). Используем только официальный **Travelpayouts Data API** (бесплатный токен партнёрской программы).
3. **Data API отдаёт цены из кэша поисков пользователей** (метод `prices_for_dates` — дешевейшие билеты, найденные за последние ~48 ч; данные хранятся до 7 дней). Это не live-поиск: цена может уже измениться. Live Search API требует большого трафика и недоступен. Следствие: в каждом уведомлении указывать «цена из кэша, найдена N ч назад — проверь перед покупкой»; поле `found_at`/`expires_at` (если есть в ответе) использовать для отсева устаревших.
4. Источник данных реализовать через интерфейс-провайдер (`FareProvider`), чтобы позже добавить другие источники без переписывания логики.

---

## 2. Архитектура и хостинг

### 2.1 Основной вариант (реализовать): Cloudflare Workers + D1 — $0

| Компонент | Реализация |
|---|---|
| Бот | Telegram **webhook** → HTTP-обработчик Worker (`fetch`) |
| Мониторинг | **Cron Triggers** Worker (`scheduled`) |
| БД | **Cloudflare D1** (SQLite) |
| Секреты | `wrangler secret put` |
| Язык | TypeScript, фреймворк бота — **grammY** (поддерживает Workers) |

Почему: не «засыпает» (в отличие от бесплатных Render/Koyeb), не нужен VPS и карта, webhook + cron покрывают и интерактивность, и фоновый опрос.

Лимиты Free-плана, под которые проектируем (Claude Code обязан перепроверить по актуальной документации Cloudflare):
- 100 000 входящих запросов/сутки на аккаунт;
- 10 мс CPU на вызов (ожидание `fetch` не считается CPU) → никаких тяжёлых вычислений в одном вызове;
- **50 subrequests на вызов** → бюджет внешних `fetch` на один тик ≤ 40 (запас);
- 5 cron-триггеров на аккаунт → используем 2.

### 2.2 Резервный вариант B (не реализовывать сейчас, только заложить совместимость ядра)
GitHub Actions (cron) + конфиг `watches.yaml` в приватном репо + состояние в JSON, коммитимом обратно. Минусы: нет интерактивного бота, задержки cron до 30–60 мин, cron отключается после 60 дней неактивности репо. Поэтому ядро (провайдер, планировщик запросов, детектор цены, форматтер) — **чистые функции без зависимостей от Workers**, адаптеры платформы отдельно.

### 2.3 Вариант C
Docker-контейнер на домашнем ПК/VPS (Node, SQLite через тот же слой репозитория). Только `Dockerfile` + README-раздел, без отдельной разработки.

---

## 3. Стек

- TypeScript (strict), Node 20+ для локальной разработки
- `wrangler` (деплой, D1 миграции, локальный запуск)
- `grammY` (webhook-адаптер для Cloudflare)
- `zod` — валидация входов API и пользовательского ввода
- `vitest` — тесты; `msw` или ручные фикстуры для мока HTTP
- Никаких ORM; SQL-миграции в `migrations/`, тонкий репозиторный слой

---

## 4. Модель данных (D1)

```sql
users(
  id INTEGER PK, tg_user_id INTEGER UNIQUE, chat_id INTEGER, username TEXT,
  tz TEXT DEFAULT 'Europe/Moscow', currency TEXT DEFAULT 'rub',
  quiet_from TEXT NULL, quiet_to TEXT NULL,          -- 'HH:MM'
  daily_alert_cap INTEGER DEFAULT 20, created_at TEXT)

watches(
  id INTEGER PK, user_id FK, name TEXT, status TEXT CHECK(status IN('active','paused','expired','deleted')),
  origins TEXT,            -- JSON массив IATA (города или аэропорты): ["MOW"] / ["MOW","LED"]
  destinations TEXT,       -- JSON массив IATA
  trip_type TEXT CHECK(trip_type IN('oneway','roundtrip')),
  depart_from TEXT, depart_to TEXT,          -- YYYY-MM-DD, окно вылета
  nights_min INTEGER NULL, nights_max INTEGER NULL,  -- для roundtrip
  return_to TEXT NULL,                        -- крайняя дата возврата (опц.)
  depart_weekdays TEXT NULL, return_weekdays TEXT NULL, -- JSON [1..7]
  direct_only INTEGER DEFAULT 0, max_transfers INTEGER NULL,
  max_duration_min INTEGER NULL,
  exclude_airlines TEXT NULL,                 -- JSON IATA
  depart_time_from TEXT NULL, depart_time_to TEXT NULL, -- фильтр времени вылета
  adults INTEGER DEFAULT 1,
  price_mode TEXT CHECK(price_mode IN('threshold','auto','both')),
  max_price INTEGER NULL,                     -- за 1 взрослого, в валюте пользователя
  auto_sensitivity REAL DEFAULT 0.20,         -- порог скидки для auto
  check_interval_min INTEGER DEFAULT 60,
  last_checked_at TEXT NULL, last_error TEXT NULL, error_count INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT)

observations(               -- сырые наблюдения, для истории и авто-режима
  id INTEGER PK, watch_id FK, observed_at TEXT,
  origin_airport TEXT, destination_airport TEXT,
  depart_date TEXT, return_date TEXT NULL,
  price INTEGER, airline TEXT, flight_number TEXT, transfers INTEGER,
  duration_min INTEGER, link TEXT, source_found_at TEXT NULL)
  -- индекс (watch_id, observed_at), (watch_id, depart_date, return_date)

daily_min(                  -- агрегат: минимальная цена по watch за сутки
  watch_id FK, day TEXT, min_price INTEGER, PRIMARY KEY(watch_id, day))

notified(                   -- анти-спам
  watch_id FK, offer_key TEXT, last_price INTEGER, last_sent_at TEXT, times_sent INTEGER,
  PRIMARY KEY(watch_id, offer_key))

api_cache(                  -- кэш ответов провайдера между тиками
  cache_key TEXT PK, payload TEXT, fetched_at TEXT)

wizard_state(               -- состояние диалога создания/редактирования
  tg_user_id INTEGER PK, step TEXT, draft TEXT, updated_at TEXT)
```

Ретеншн: `observations` старше 60 дней удалять (агрегаты `daily_min` оставлять 365 дней).

---

## 5. Провайдер данных: Travelpayouts / Aviasales Data API

### 5.1 Эндпоинты (перепроверить по документации перед реализацией)
- **Основной:** `GET https://api.travelpayouts.com/aviasales/v3/prices_for_dates`
  Параметры: `origin`, `destination`, `departure_at` (`YYYY-MM` или `YYYY-MM-DD`), `return_at`, `one_way`, `direct`, `sorting=price`, `unique=false`, `limit`, `page`, `currency`, `market`.
  Токен — в заголовке `X-Access-Token` (не в URL, чтобы не светить в логах).
  Ответ содержит: `origin_airport`, `destination_airport`, `price`, `airline`, `flight_number`, `departure_at`, `return_at`, `transfers`, `return_transfers`, `duration`, `duration_to`, `duration_back`, `link`.
- **Для бутстрапа истории (авто-режим):** `aviasales/v3/grouped_prices` (группировка по дате вылета) и/или `v2/prices/month-matrix` — календарь минимальных цен.
- **Автодополнение городов:** `https://autocomplete.travelpayouts.com/places2?term=...&locale=ru&types[]=city&types[]=airport` — для перевода «Москва» → `MOW`.

### 5.2 Планировщик запросов (QueryPlanner) — ключевая логика экономии
Watch с гибкими датами разворачивается в **минимальный набор запросов с гранулярностью «месяц»**, а точная фильтрация делается локально:
- oneway: для каждой пары (origin, destination) × каждый месяц, пересекающийся с `[depart_from, depart_to]` → 1 запрос `departure_at=YYYY-MM`.
- roundtrip: месяцы вылета × месяцы возврата, где месяц возврата ∈ [месяц(depart_from + nights_min), месяц(depart_to + nights_max)] (или до `return_to`).
- Если окно ≤ 3 дней — допустимы запросы на конкретные дни, если это даёт меньше запросов.
- Пагинация: запрашивать `limit` максимальный из разрешённого; следующую страницу — только если последняя цена на странице ещё ≤ текущего целевого порога.
- **Дедупликация между watch:** одинаковые `cache_key` (нормализованные параметры) выполняются один раз за тик; результат кладётся в `api_cache` с TTL 30 мин.
- Функция `planQueries(watch, today) → Query[]` — чистая, покрыта тестами. Ограничить разворот: > 24 запросов на один watch → отказ при создании с объяснением («сузь даты или список аэропортов»).

### 5.3 Нормализация и фильтрация
`normalize(raw) → Offer`:
```
Offer { originAirport, destAirport, departAt (ISO с временем), returnAt?, price, currency,
        airline, flightNumber, transfersOut, transfersBack, durationMin, link, foundAt? }
```
Фильтры (чистая функция `matchesWatch(offer, watch)`): дата вылета в окне; nights = returnDate − departDate ∈ [min, max]; `return_to`; дни недели; direct/max_transfers (учитывать и туда, и обратно); длительность; исключённые авиакомпании; время вылета; `departAt` не в прошлом и не раньше чем через 3 часа.

### 5.4 Ссылка на покупку
`https://www.aviasales.ru` + `offer.link`. Если задан `TRAVELPAYOUTS_MARKER` — добавить `marker=<marker>` (партнёрская метка, опционально). Если `link` пустой — собрать поисковую ссылку формата `/search/{ORIG}{DDMM}{DEST}{DDMM возврата}{adults}` (формат перепроверить). Ссылку показывать inline-кнопкой «Купить на Aviasales».

### 5.5 Ошибки провайдера
401 → сообщение админу «неверный токен», остановить тик. 429 → экспоненциальный backoff (глобальный флаг `rate_limited_until` в БД). 5xx/timeout (таймаут 8 с) → retry 1 раз, затем `watch.error_count++`; после 10 ошибок подряд — уведомить пользователя.

---

## 6. Логика «дешёвой цены» (PriceDetector)

Режимы на уровне watch:
- `threshold` — сработка, если `price ≤ max_price`.
- `auto` — порог вычисляется из истории.
- `both` (по умолчанию, если задан max_price) — сработка при любом из условий; в тексте указать причину.

### 6.1 Авто-режим
1. Каждый тик: сохранить все подходящие офферы в `observations`, обновить `daily_min(watch, today)`.
2. **Baseline** = медиана `daily_min` за последние 21 день (нужно ≥ 5 дней данных).
3. **Cold start** (< 5 дней): при создании watch сделать бутстрап — через `grouped_prices`/`month-matrix` взять минимальные цены по дням вылета в окне (и в соседних месяцах того же маршрута), baseline = медиана этих значений; пометить `confidence=low`. Для low-confidence требовать скидку в 1.5 раза больше.
4. Сработка auto, если выполнено одно:
   - `price ≤ baseline × (1 − auto_sensitivity)` (по умолчанию −20%);
   - `price < исторический минимум watch` при ≥ 7 днях истории (новый рекорд).
5. В уведомлении показать: «на X% ниже медианы за 21 день (медиана Y ₽)».
6. Все пороги — константы в `config.ts`, покрыты тестами на синтетических рядах.

Ограничение, которое надо показать пользователю в `/help`: история строится по кэшу Aviasales, поэтому для редких направлений данных может быть мало, и авто-режим будет консервативным.

---

## 7. Анти-спам и дедупликация (Notifier)

- `offer_key` = `origin_airport|dest_airport|depart_date|return_date|airline|flight_number`.
- Повторно уведомлять о том же `offer_key`, только если цена упала на ≥ 5% **и** ≥ 300 ₽ относительно `last_price` (константы).
- Если за тик несколько подходящих офферов по одному watch — **одно сообщение**, топ-3 по цене + «ещё N вариантов» (кнопка «Показать все» → до 10).
- Дневной лимит сообщений на пользователя (`daily_alert_cap`); при превышении — одно сообщение «лимит достигнут, остальное в дайджесте».
- Тихие часы: сообщения копятся в очередь (таблица или поле) и уходят одним дайджестом после окончания тихих часов. Исключение: цена ниже `max_price` на ≥ 30% — отправлять сразу, но с `disable_notification=true`.
- Отправка в Telegram: учитывать `429 retry_after`.

---

## 8. Telegram-бот

### 8.1 Доступ
- `ALLOWED_USERNAMES` (через запятую, без @). Чужим — вежливый отказ, без раскрытия деталей.
- `ADMIN_USERNAME` — получает системные ошибки и ежедневный heartbeat.
- При `/start` сохранить `chat_id`. Если username у пользователя сменился — работать по `tg_user_id` после первой привязки.

### 8.2 Команды
| Команда | Действие |
|---|---|
| `/start` | привязка, приветствие, краткая инструкция |
| `/new` | мастер создания наблюдения |
| `/list` | список watch: маршрут, окно дат, порог, статус, лучшая текущая цена; inline-кнопки: ⏸/▶️, ✏️, 🗑, 🔄 проверить сейчас |
| `/check <id>` | внеочередная проверка (rate limit: 1 раз/5 мин на watch) |
| `/history <id>` | мин. цена по дням за 30 дней (текстовая мини-сводка: мин/медиана/макс + последние 7 дней) |
| `/settings` | часовой пояс, тихие часы, дневной лимит |
| `/help` | форматы ввода, объяснение ограничений данных |

### 8.3 Мастер `/new` (шаги, каждое поле с кнопкой «Назад»/«Отмена»)
1. **Откуда** — текст («Москва», «MOW», «Москва, Питер»). Резолв через autocomplete; при неоднозначности — inline-кнопки выбора. Город-код (MOW) покрывает все аэропорты города.
2. **Куда** — аналогично (можно несколько).
3. **Тип** — «туда-обратно» / «в одну сторону».
4. **Даты вылета** — принимать форматы: `15.11-30.11`, `15.11.2026-02.12.2026`, `ноябрь`, `ноябрь-декабрь`, `15.11` (один день), `±3 от 20.11`. Парсер — чистая функция с тестами; год подставлять ближайший будущий.
5. **Ночей** (roundtrip) — `7`, `5-9`, кнопки-пресеты (3–5, 6–9, 10–14). Опционально «вернуться не позже».
6. **Фильтры** (можно пропустить): только прямые / макс. пересадок; дни недели вылета (кнопки Пн…Вс); без ночных вылетов.
7. **Цена** — «Ввести максимум» (число, ₽ за 1 взрослого) / «Пусть бот решает сам» / «Оба варианта». Подсказка: при вводе показать текущую минимальную цену по этому маршруту в окне (1 запрос), чтобы пользователь видел реалистичный уровень.
8. **Подтверждение** — сводка + «Создать». После создания: сразу выполнить первую проверку и прислать текущий минимум (даже если он выше порога) как «точку отсчёта».

Состояние мастера — в `wizard_state` (TTL 30 мин).

### 8.4 Формат уведомления (HTML parse mode)
```
✈️ Москва (SVO) → Стамбул (SAW)
💰 8 450 ₽ — ниже твоего порога 10 000 ₽ на 15%
📅 12 ноя (ср) 06:40 → 19 ноя (ср), 7 ночей
🔁 1 пересадка туда · прямой обратно · Pegasus PC 395
🕒 Цена из кэша Aviasales, найдена ~3 ч назад — проверь перед покупкой
[Купить на Aviasales]  [⏸ Пауза watch]  [🔕 Не показывать этот рейс]
```
Для auto: «на 27% ниже медианы за 21 день (11 600 ₽)». Для нескольких взрослых: «≈ 16 900 ₽ за 2 взрослых (оценка)».

---

## 9. Планировщик (cron)

Два триггера:
- `*/15 * * * *` — **tick**.
- `7 3 * * *` — **daily maintenance** (UTC).

**tick:**
1. Если `rate_limited_until > now` — выход.
2. Выбрать active watch, у которых `now − last_checked_at ≥ check_interval_min`, сортировка по `last_checked_at ASC NULLS FIRST`.
3. Для каждого: `planQueries` → добавлять в пул, пока суммарные уникальные запросы ≤ **30** (бюджет subrequests с запасом на Telegram-отправки). Остальные watch — в следующий тик (round-robin, без голодания).
4. Выполнить запросы (параллельно ≤ 6), с кэшем.
5. Для каждого watch: фильтр → сохранить observations → PriceDetector → Notifier.
6. Обновить `last_checked_at`. Все шаги идемпотентны: повтор тика не шлёт дубли.

**daily maintenance:** перевод watch с прошедшим окном в `expired` (+ сообщение пользователю с итоговым минимумом за всё время), ретеншн таблиц, отправка отложенных дайджестов, heartbeat админу («активных watch: N, запросов к API за сутки: M, ошибок: K»).

Счётчики запросов за сутки хранить в БД для контроля лимитов.

---

## 10. Безопасность

- Webhook: путь `/tg/<random>` + проверка заголовка `X-Telegram-Bot-Api-Secret-Token` (задаётся в `setWebhook`). Всё остальное → 404.
- Секреты только через `wrangler secret`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TRAVELPAYOUTS_TOKEN`. Переменные: `ALLOWED_USERNAMES`, `ADMIN_USERNAME`, `TRAVELPAYOUTS_MARKER` (опц.), `DEFAULT_CURRENCY`.
- Не логировать токены и полные URL с токенами.
- Валидация всего пользовательского ввода через zod; лимит 20 active watch на пользователя.
- `.dev.vars` в `.gitignore`, пример — `.dev.vars.example`.

---

## 11. Структура репозитория

```
/src
  index.ts              # fetch (webhook) + scheduled (cron) — только роутинг
  config.ts             # константы порогов, лимиты, бюджеты
  core/                 # ЧИСТАЯ логика, без Workers API
    types.ts
    dateParser.ts
    queryPlanner.ts
    filters.ts
    priceDetector.ts
    notifyPolicy.ts     # дедуп, лимиты, тихие часы
    format.ts           # тексты сообщений
    links.ts
  providers/
    FareProvider.ts     # интерфейс
    travelpayouts.ts
    autocomplete.ts
  bot/
    bot.ts              # grammY setup, middleware доступа
    commands/*.ts
    wizard.ts
    keyboards.ts
  jobs/
    tick.ts
    daily.ts
  db/
    repo.ts             # все SQL-запросы
/migrations/0001_init.sql
/scripts/set-webhook.ts
/test/                  # vitest; фикстуры ответов API в /test/fixtures
wrangler.toml
Dockerfile              # вариант C (опционально, последним этапом)
README.md
.dev.vars.example
```

---

## 12. Тестирование

- Unit (обязательно, покрытие core ≥ 85%): `dateParser` (все форматы, переход года), `queryPlanner` (разворот месяцев, лимит 24), `filters` (ночи, дни недели, пересадки туда/обратно), `priceDetector` (cold start, медиана, новый минимум, low-confidence), `notifyPolicy` (повторы, лимит, тихие часы, таймзона).
- Интеграционные: tick на моках провайдера и Telegram — проверка, что при двух тиках подряд с той же ценой уведомление одно.
- Фикстуры строить по документированной схеме ответа; отдельный скрипт `npm run smoke` делает 1 реальный запрос к API с токеном из `.dev.vars` и валидирует схему через zod (для проверки, что API не изменился).
- Режим `DRY_RUN=1`: вместо отправки в Telegram — лог.

---

## 13. Деплой (README должен содержать эти шаги пошагово)

1. Создать бота у @BotFather → токен.
2. Зарегистрироваться в Travelpayouts (бесплатно), подключить программу Aviasales, получить API-токен (раздел Data API/Инструменты) и marker.
3. Аккаунт Cloudflare (бесплатный), `npm i`, `npx wrangler login`.
4. `npx wrangler d1 create farewatch` → вписать id в `wrangler.toml`; `npx wrangler d1 migrations apply farewatch --remote`.
5. `npx wrangler secret put ...` для каждого секрета.
6. `npx wrangler deploy`.
7. `npm run set-webhook` (скрипт вызывает `setWebhook` с URL Worker и secret_token).
8. Открыть бота, `/start`, `/new`.
Опционально: GitHub Actions workflow, который на push в `main` гоняет тесты и `wrangler deploy` (секрет `CLOUDFLARE_API_TOKEN`).

---

## 14. Этапы и критерии приёмки

| # | Этап | Готово, когда |
|---|---|---|
| 1 | Каркас: wrangler, D1 миграция, webhook, `/start` с allowlist | бот отвечает только разрешённому username, chat_id сохранён |
| 2 | Провайдер Travelpayouts + autocomplete + `npm run smoke` | реальный запрос возвращает валидные офферы |
| 3 | core: dateParser, queryPlanner, filters + тесты | тесты зелёные |
| 4 | Мастер `/new`, `/list`, пауза/удаление | watch создаётся из чата, первая проверка присылает текущий минимум |
| 5 | tick + threshold-режим + Notifier + дедуп | при цене ниже порога приходит одно сообщение с корректной ссылкой |
| 6 | auto-режим, бутстрап истории, `/history` | детектор проходит тесты на синтетике; в сообщении указана причина |
| 7 | daily job, тихие часы, дайджест, heartbeat, expire | watch с прошедшим окном закрывается с итоговым сообщением |
| 8 | README, CI, Dockerfile (опц.) | чистый деплой по README с нуля за ≤ 20 мин |

---

## 15. Вне скоупа (не делать без запроса)

- Скрейпинг сайтов, headless-браузеры.
- Оплата/бронирование.
- Мультипользовательский SaaS, веб-интерфейс.
- Другие источники цен (оставить только интерфейс `FareProvider`).

## 16. Инструкции для Claude Code

- Перед этапом 2 открыть актуальную документацию Travelpayouts Data API и Cloudflare Workers limits; если параметры/лимиты отличаются от этого ТЗ — остановиться и сообщить, предложив правку.
- Всё, что в ТЗ помечено «перепроверить», не хардкодить по памяти.
- Каждый этап — отдельный коммит; после этапа кратко отчитываться: что сделано, что проверено, открытые вопросы.
- Не добавлять зависимости сверх раздела 3 без обоснования.
