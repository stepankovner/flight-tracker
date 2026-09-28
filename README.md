# FlightTracker ✈️

Telegram-бот, который следит за ценами на авиабилеты Aviasales и пишет, когда становится дёшево.

Пользователь создаёт наблюдения прямо в чате: откуда, куда, гибкое окно дат, сколько ночей, фильтры и порог цены (или «пусть бот решает сам»). Сервис раз в час опрашивает официальный [Travelpayouts Data API](https://support.travelpayouts.com/hc/en-us/articles/203956163) и присылает уведомление, если билет дешевле порога или заметно дешевле обычного. В уведомлении — маршрут, цена, даты, пересадки и кнопка «Купить на Aviasales».

- Работает 24/7 на **бесплатном** Cloudflare Workers + D1: не засыпает, карта не нужна.
- Деплой — несколько команд; данные в D1 переживают перезапуски и передеплои.
- Техническое задание — [`SPEC.md`](SPEC.md), принятые решения и отклонения — [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Что умеет бот

| Команда | Что делает |
|---|---|
| `/new` | мастер создания наблюдения (города с автодополнением, даты в свободной форме, ночи, фильтры, порог или авто-режим) |
| `/list` | список наблюдений: текущая лучшая цена, ⏸/▶️, ✏️ правка, 🗑 удаление, 🔄 проверить сейчас |
| `/check N` | внеочередная проверка (не чаще раза в 5 минут) |
| `/history N` | минимальные цены по дням за 30 дней: мин / медиана / макс, мини-график, последние 7 дней |
| `/settings` | часовой пояс, тихие часы, дневной лимит уведомлений |
| `/help` | форматы ввода и ограничения данных |
| `/status` | (админ) счётчики API и Telegram, состояние планировщика |

Маршрут можно ввести сразу одной строкой: «Москва - Алматы». Даты понимаются в таких видах: `15.11-30.11`, `15.11.2026-02.12.2026`, `ноябрь`, `ноябрь-декабрь`, `15.11`, `±3 от 20.11`, `15-30 ноября`.

**Режимы цены:**
- **Порог** — уведомление, когда цена за 1 взрослого не выше заданной.
- **Авто** — бот копит историю минимальных цен и срабатывает при цене на 20%+ ниже медианы за 21 день или при новом минимуме. На холодном старте опирается на календарь цен Aviasales и требует скидку в 1,5 раза больше.
- **Оба** — срабатывает любое из условий, причина пишется в сообщении.

**Анти-спам.** Про тот же рейс бот пишет повторно, только если цена упала ещё на 5% и 300 ₽. Несколько вариантов по наблюдению приходят одним сообщением (топ-3 и кнопка «Показать все»). Работает дневной лимит. В тихие часы уведомления копятся и приходят утром одним дайджестом; очень выгодные (ниже порога на 30%+) приходят сразу, но без звука.

## Ограничения данных

Цены берутся из **кэша поисков пользователей Aviasales** за последние ~48 часов (API `prices_for_dates`). Это не живой поиск: цена могла измениться, поэтому в каждом уведомлении написано, когда она найдена, и есть просьба проверить перед покупкой. Для редких направлений данных бывает мало, и авто-режим тогда осторожничает. Парсинга сайта нет: он запрещён правилами Aviasales и нестабилен.

## Архитектура

```
Telegram ──webhook──▶ Worker.fetch ──▶ grammY-бот ──▶ D1 (SQLite)
                                          │  └─ первая проверка / /check → ctx.waitUntil
Cron */5  ──▶ Worker.scheduled ──▶ tick: due-watch → QueryPlanner → кэш/Travelpayouts
                                          → фильтры → PriceDetector → outbox → Telegram
Cron 03:07 UTC ──▶ daily: истечение, ретеншн, справочники, дайджесты, heartbeat админу
```

- `src/core/` — чистая логика без Workers API: парсер дат, планировщик запросов, фильтры, детектор цены, политика уведомлений, тексты. Её же можно использовать в резервных вариантах B и C.
- `src/providers/` — интерфейс `FareProvider` и реализация Travelpayouts плюс автодополнение городов.
- `src/db/repo.ts` — все SQL-запросы; работает и на D1, и на `node:sqlite` через один интерфейс.
- `src/jobs/` — проверка, рассылка, tick, daily. `src/bot/` — команды, мастер, кнопки.

Бесплатный план Cloudflare ограничивает один вызов 50 subrequests и 10 мс CPU, поэтому тик укладывается в бюджет:
- до 24 запросов к API и ~450 КБ ответов (CPU замерен на самом Workers);
- одинаковые запросы разных наблюдений объединяются и кэшируются на 30 минут;
- D1 вызывается пачками;
- наблюдения, не влезшие в тик, проверяются следующим;
- если платформа оборвала тик, его наблюдения уходят в конец очереди, а объём работы за тик временно уменьшается.

Подробности — в [`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## Деплой с нуля (≈ 15 минут)

Понадобятся Node.js 22+ и git.

### 1. Бот в Telegram
Напиши [@BotFather](https://t.me/BotFather) команду `/newbot`, придумай имя и username и получи **токен** вида `123456789:AAE...`.

### 2. Токен Travelpayouts
1. Зарегистрируйся на [travelpayouts.com](https://www.travelpayouts.com/) (бесплатно) и создай проект: подойдёт любой сайт или канал.
2. В разделе программ подключи **Aviasales**.
3. **API-токен** — в [профиле → API token](https://app.travelpayouts.com/profile/api-token) (32 символа).
4. Необязательно: **marker** (ID партнёра) — тогда покупки по кнопке «Купить» будут засчитываться тебе.

### 3. Cloudflare и проект
Заведи бесплатный аккаунт на [dash.cloudflare.com](https://dash.cloudflare.com/sign-up), затем:

```bash
git clone https://github.com/stepankovner/flight-tracker.git
cd flight-tracker
npm ci
npx wrangler login
```

### 4. База D1
```bash
npx wrangler d1 create farewatch
```
Скопируй `database_id` из вывода в `wrangler.toml` (секция `[[d1_databases]]`) и примени миграции:
```bash
npm run db:migrate:remote
```

### 5. Первый деплой
```bash
npx wrangler deploy
```
В конце вывода будет URL вида `https://farewatch.<твой-поддомен>.workers.dev` — он понадобится на шаге 7. При первом деплое Cloudflare может попросить выбрать поддомен `workers.dev`.

### 6. Секреты
```bash
cp .dev.vars.example .dev.vars
```
Заполни в `.dev.vars` токены и username (без @), затем:
```bash
npm run secrets:push
```
Скрипт проверит токен бота, сгенерирует секрет вебхука (если пусто) и одной командой (`wrangler secret bulk`) зальёт `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TRAVELPAYOUTS_TOKEN`, `ALLOWED_USERNAMES`, `ADMIN_USERNAME`, `TRAVELPAYOUTS_MARKER` и `BOT_INFO`. `.dev.vars` в `.gitignore` и в репозиторий не попадёт.

### 7. Webhook
```bash
npm run set-webhook -- --url https://farewatch.<твой-поддомен>.workers.dev
```
Скрипт вызывает `setWebhook` с `secret_token` и настраивает меню команд. Проверить состояние: `npm run set-webhook -- --info`.

### 8. Готово
Открой бота в Telegram, нажми `/start`, затем `/new`. Планировщик срабатывает каждые 5 минут небольшими порциями; каждое наблюдение проверяется раз в час. Раз в сутки админу приходит heartbeat «💓 Жив…» со статистикой.

Проверить, что API отвечает и его формат не изменился:
```bash
npm run smoke
```

### Автодеплой из GitHub (необязательно)
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) на каждый push гоняет проверку типов, тесты и сборку бандла. На push в `main` он же применяет миграции и деплоит, если в репозитории заданы секреты (*Settings → Secrets and variables → Actions*):
- `CLOUDFLARE_API_TOKEN` — [создать токен](https://dash.cloudflare.com/profile/api-tokens) по шаблону **Edit Cloudflare Workers** и добавить право **Account → D1 → Edit**;
- `CLOUDFLARE_ACCOUNT_ID` — есть на главной странице дашборда Cloudflare.

Еженедельный [`smoke.yml`](.github/workflows/smoke.yml) проверяет схему API, если задан секрет `TRAVELPAYOUTS_TOKEN`.

---

## Эксплуатация

| Задача | Как |
|---|---|
| Живые логи | `npx wrangler tail` (или Workers Logs в дашборде) |
| Добавить или убрать пользователя | поправить `ALLOWED_USERNAMES` в `.dev.vars` → `npm run secrets:push`. Каждый новый пользователь должен сам нажать `/start`: Telegram не даёт боту писать первым |
| Сменить токен | обновить `.dev.vars` → `npm run secrets:push` (для бота — ещё `npm run set-webhook`) |
| Бэкап БД | `npx wrangler d1 export farewatch --remote --output backup.sql`; плюс D1 Time Travel на 7 дней |
| SQL руками | `npx wrangler d1 execute farewatch --remote --command "SELECT id, name, status, last_min_price FROM watches"` |
| Статус | команда `/status` админу в боте |

Бот сам сообщает админу, если:
- Travelpayouts отверг токен (401);
- API долго отвечает 429;
- падает обработчик или фоновая задача.

После 10 ошибок источника подряд по одному наблюдению бот пишет и пользователю. Если ежедневный heartbeat перестал приходить, смотри логи.

**Про лимит CPU (10 мс на бесплатном плане).** Замер на боевом Worker:
- проверка наблюдения с запросом к API — около 15 мс CPU, из них ~10 мс холодный старт;
- пустой тик — 2–10 мс.

Cloudflare пропускает такие разовые превышения. Если платформа всё же оборвёт тик, бот сам уменьшит порции работы и напишет админу; в heartbeat и `/status` видно число «оборванных тиков». Если они повторяются изо дня в день, есть два выхода: сократить число или ширину наблюдений либо перейти на Workers Paid ($5/мес, лимит CPU 30 с) — код менять не нужно.

## Локальная разработка

```bash
npm ci
cp .dev.vars.example .dev.vars          # DRY_RUN=1 — сообщения не уходят в Telegram, а пишутся в лог
npm run db:migrate:local
npm run dev                              # wrangler dev с поддержкой cron
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"    # запустить tick вручную
```

```bash
npm run check      # tsc + все тесты
npm run coverage   # покрытие (порог для src/core — 85%)
```

Тесты — `vitest`:
- юнит-тесты ядра на синтетических данных;
- интеграционные тесты tick/dispatch/daily и мастера на настоящем SQLite (`node:sqlite`) с теми же миграциями;
- тесты провайдера на фикстурах по документированной схеме (`test/fixtures`).

## Вариант C: Docker на своём ПК или VPS

Тот же код, но с SQLite-файлом, long polling (публичный HTTPS не нужен) и встроенным планировщиком:
```bash
docker build -t farewatch .
docker run -d --name farewatch --restart unless-stopped \
  --env-file .dev.vars -v farewatch-data:/data farewatch
```
Одновременно с Worker запускать нельзя: при старте контейнер снимает webhook. Чтобы вернуться на Cloudflare, снова выполни `npm run set-webhook`.

## Вариант B (не реализован)
GitHub Actions по cron + конфиг в репозитории. Ядро (`src/core`) и провайдер для этого готовы: они не зависят от Workers. Но у варианта нет интерактивного бота, cron отстаёт на 30–60 минут и отключается после 60 дней без коммитов, поэтому основной вариант — Cloudflare.

## Структура

```
src/
  index.ts            # роутинг: webhook → бот, cron → задачи
  config.ts           # все пороги, лимиты и бюджеты
  core/               # чистая логика (dateParser, queryPlanner, filters, priceDetector, notifyPolicy, format, links)
  providers/          # FareProvider, travelpayouts, autocomplete
  bot/                # grammY: bot.ts, wizard.ts, commands/*, alerts.ts, ui.ts
  jobs/               # checker (проверка), dispatch (рассылка), tick, daily, manual, preview
  db/                 # sql.ts (интерфейс), repo.ts (все SQL), nodeSqlite.ts (адаптер Node)
  platform/           # env, telegram, budget, log
  node/main.ts        # точка входа варианта C
migrations/           # SQL-миграции D1
scripts/              # set-webhook, push-secrets, smoke
test/                 # vitest + фикстуры
```
