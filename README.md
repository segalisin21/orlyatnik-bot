# Орлятник 21+ — Telegram-бот

Production-ready бот для лагеря «Орлятник 21+»: консультации, сбор анкеты, приём оплаты (чек), уведомление админа, выдача ссылки на чат после подтверждения. LLM-ассистент, CRM в Google Sheets, state-machine, деплой на Railway.

## Стек

- Node.js 20+, TypeScript
- Grammy (Telegram Bot API)
- Google Sheets API (service account)
- OpenAI (Chat Completions + Whisper)
- Express (webhook), node-cron (проверка подтверждений)

## Настройка

### 1. Токены и переменные окружения

Создайте `.env` (или задайте переменные в Railway):

```env
# Telegram
BOT_TOKEN=your_bot_token_from_@BotFather
TELEGRAM_MODE=long_poll   # или webhook для продакшена

# OpenAI
OPENAI_API_KEY=sk-...

# Google Sheets (JSON ключа сервис-аккаунта — в одну строку или путь к файлу)
GOOGLE_SHEETS_CREDENTIALS={"type":"service_account",...}
# или
GOOGLE_SHEETS_CREDENTIALS_PATH=./keys/service-account.json

GOOGLE_SHEET_ID=id_вашей_таблицы

# Админ и менеджер
ADMIN_CHAT_ID=123456789
MANAGER_TG_USERNAME=krisis_pr
CHAT_INVITE_LINK=https://t.me/joinchat/...
```

### 2. Google Sheets — сервис-аккаунт

1. [Google Cloud Console](https://console.cloud.google.com/) → создать проект (или выбрать существующий).
2. Включить **Google Sheets API** и **Google Drive API**.
3. **IAM & Admin** → **Service Accounts** → создать сервис-аккаунт, скачать JSON-ключ.
4. Открыть вашу Google-таблицу → **Настройки доступа** → добавить email сервис-аккаунта (вид `...@....iam.gserviceaccount.com`) с правом **Редактор**.

В Railway: содержимое JSON-ключа положить в переменную `GOOGLE_SHEETS_CREDENTIALS` (всё в одну строку). Либо загрузить файл и указать путь через `GOOGLE_SHEETS_CREDENTIALS_PATH` (если поддерживается).

### 3. Структура Google-таблицы

- **Лист «Участники»** (имя листа именно «Участники»). Колонки (первая строка — заголовки):
  - `user_id`, `username`, `chat_id`, `status`, `fio`, `city`, `dob`, `companions`, `phone`, `comment`, `shift`, `payment_proof_file_id`, `final_sent_at`, `updated_at`, `created_at`
- **Лист «Логи»**:
  - `timestamp`, `user_id`, `status`, `direction`, `message_type`, `text_preview`, `raw_json`

Бот создаёт строки в «Участники» при первом обращении пользователя; «Логи» только дополняет.

### 4. Webhook (продакшен)

Для Railway задайте:

- `TELEGRAM_MODE=webhook`
- `WEBHOOK_SECRET=случайная_строка` (для проверки запросов)
- После деплоя укажите URL: `https://ваш-сервис.railway.app/webhook`

Установка webhook (один раз или после смены URL):

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://ваш-сервис.railway.app/webhook"
```

Локально для разработки: `TELEGRAM_MODE=long_poll` — бот сам опрашивает API.

## Запуск

```bash
npm install
npm run build
npm start
```

Локальная разработка с автоперезапуском (по желанию):

```bash
npx ts-node src/index.ts
```

## Пошаговое развёртывание на Railway

### Шаг 1. Telegram-бот

1. Открой Telegram, найди **@BotFather**.
2. Отправь `/newbot`, придумай имя и username (должен заканчиваться на `bot`, например `orlyatnik21_bot`).
3. Скопируй **токен** вида `123456789:AAH...` — это твой `BOT_TOKEN`.

---

### Шаг 2. Google-таблица и сервис-аккаунт

1. Создай [Google-таблицу](https://sheets.google.com) (или открой существующую).
2. В первой строке листа **«Участники»** впиши заголовки (одно слово в ячейку):
   ```
   user_id | username | chat_id | status | fio | city | dob | companions | phone | comment | shift | payment_proof_file_id | final_sent_at | updated_at | created_at
   ```
3. Добавь второй лист, назови его **«Логи»**. В первой строке:
   ```
   timestamp | user_id | status | direction | message_type | text_preview | raw_json
   ```
4. Скопируй **ID таблицы** из адресной строки:
   - URL вида `https://docs.google.com/spreadsheets/d/ЭТОТ_ID_РЕДАКТИРУЕШ/d...`
   - Это твой `GOOGLE_SHEET_ID`.

5. **Сервис-аккаунт:**
   - Зайди в [Google Cloud Console](https://console.cloud.google.com/).
   - Создай проект (или выбери существующий) → вверху выбери его.
   - **APIs & Services** → **Library** → найди **Google Sheets API** → **Enable**. То же для **Google Drive API** → **Enable**.
   - **APIs & Services** → **Credentials** → **Create Credentials** → **Service account**.
   - Имя любое (например `orlyatnik-bot`) → **Create and Continue** → **Done**.
   - Кликни по созданному сервис-аккаунту → вкладка **Keys** → **Add Key** → **Create new key** → **JSON** → скачай файл.
   - Открой скачанный JSON. Скопируй **весь** его содержимое в одну строку (без переносов) — это будет значение `GOOGLE_SHEETS_CREDENTIALS`. Либо оставь файл и потом укажешь путь (на Railway обычно используют переменную).
   - Открой свою Google-таблицу → **Настройки доступа** (Share) → **Add people** → вставь email из JSON (поле `client_email`, вид `...@....iam.gserviceaccount.com`) → право **Editor** → **Send**.

---

### Шаг 3. OpenAI API ключ

1. Зайди на [platform.openai.com](https://platform.openai.com/) → **API keys** → **Create new secret key**.
2. Скопируй ключ (начинается с `sk-...`) — это `OPENAI_API_KEY`.

---

### Шаг 4. ID чата для админа и ссылка на чат участников

1. **ADMIN_CHAT_ID** — куда бот будет слать уведомления о чеках:
   - Напиши боту в Telegram любое сообщение (бот пока может не отвечать).
   - Открой в браузере: `https://api.telegram.org/bot<ВСТАВЬ_BOT_TOKEN>/getUpdates`.
   - В ответе найди `"chat":{"id": 123456789` — это и есть `ADMIN_CHAT_ID` (число, можно с минусом для лички).
2. **CHAT_INVITE_LINK** — приглашение в чат участников после оплаты (например `https://t.me/joinchat/...`). Создай чат в Telegram → **Add members** → **Invite via link** → скопируй ссылку.
3. **MANAGER_TG_USERNAME** — уже задан в коде как `krisis_pr`; при необходимости переопредели через переменную `MANAGER_TG_USERNAME`.

---

### Шаг 5. Репозиторий и Railway

1. Инициализируй git в папке проекта (если ещё не сделано):
   ```bash
   git init
   git add .
   git commit -m "Initial: Orlyatnik bot"
   ```
   **Важно:** без коммита ветки `main` (или `master`) не существует — тогда при push будет ошибка «src refspec main does not match any».

2. Создай репозиторий на GitHub (пустой, без README). В URL используй **username**, не email: `https://github.com/ТВОЙ_USERNAME/orlyatnik-bot.git`.

3. Подключи remote и запушь. Если Git создал ветку **master**, а не main — пушь ту ветку, что есть:
   ```bash
   git remote add origin https://github.com/ТВОЙ_USERNAME/orlyatnik-bot.git
   git branch
   ```
   Если видишь `* master`, то:
   ```bash
   git push -u origin master
   ```
   Если видишь `* main`, то:
   ```bash
   git push -u origin main
   ```
   Либо переименуй ветку в main и запушь:
   ```bash
   git branch -M main
   git push -u origin main
   ```
4. Зайди на [railway.app](https://railway.app), войди через GitHub.
5. **New Project** → **Deploy from GitHub repo** → выбери репозиторий с ботом.
6. Railway создаст сервис. Кликни по нему.

---

### Шаг 6. Настройка сервиса в Railway

1. Вкладка **Settings**:
   - **Build Command:** `npm run build` (или оставь пустым, если в проекте есть Nixpacks/автоопределение и скрипт `build` в `package.json`).
   - **Start Command:** `node dist/index.js`
   - **Root Directory:** оставь пустым (корень репозитория).
2. Вкладка **Variables** — добавь переменные (каждую через **New Variable** или **Raw Editor**):

   | Переменная | Значение |
   |------------|----------|
   | `BOT_TOKEN` | токен от BotFather |
   | `TELEGRAM_MODE` | `webhook` |
   | `WEBHOOK_SECRET` | придумай длинную случайную строку (например сгенерируй на random.org) |
   | `OPENAI_API_KEY` | ключ OpenAI `sk-...` |
   | `GOOGLE_SHEETS_CREDENTIALS` | весь JSON сервис-аккаунта **в одну строку** |
   | `GOOGLE_SHEET_ID` | ID таблицы из шага 2 |
   | `ADMIN_CHAT_ID` | число, твой Telegram user id (куда приходят уведомления о чеках). **Важно:** сначала напиши боту /start — иначе бот не сможет отправить тебе сообщения. |
   | `MANAGER_TG_USERNAME` | `krisis_pr` (или другой) |
   | `CHAT_INVITE_LINK` | ссылка на чат участников |

   Для `GOOGLE_SHEETS_CREDENTIALS`: открой JSON-файл ключа, скопируй всё содержимое, убери переносы строк (или замени на пробелы), вставь в значение переменной в кавычках если редактор требует.

3. **Публичный домен:**
   - В том же сервисе открой вкладку **Settings** → раздел **Networking** (или **Public Networking**).
   - **Generate Domain** (или **Add domain**). Railway выдаст URL вида `твой-сервис.up.railway.app`.
   - Скопируй этот URL — понадобится для webhook.

---

### Шаг 7. Деплой и установка webhook

1. После сохранения переменных Railway автоматически пересоберёт и запустит проект. Дождись зелёного статуса **Deployed**.
2. Открой сгенерированный домен в браузере: `https://твой-сервис.up.railway.app/health` — в ответ должно быть `ok`. Если нет — проверь логи в Railway (вкладка **Deployments** → клик по деплою → **View Logs**).
3. Установи webhook в Telegram. **Обязательно укажи `allowed_updates`** — иначе кнопка «Подтвердить оплату» не будет работать (Telegram не будет присылать `callback_query`).

   **В PowerShell (Windows)** — с секретом и типами обновлений (подставь BOT_TOKEN, домен, WEBHOOK_SECRET):
   ```powershell
   Invoke-RestMethod -Uri "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -Method Post -ContentType "application/json" -Body '{"url":"https://твой-сервис.up.railway.app/webhook","secret_token":"<ТВОЙ_WEBHOOK_SECRET>","allowed_updates":["message","callback_query","edited_message"]}'
   ```
   Без секрета:
   ```powershell
   Invoke-RestMethod -Uri "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -Method Post -ContentType "application/json" -Body '{"url":"https://твой-сервис.up.railway.app/webhook","allowed_updates":["message","callback_query","edited_message"]}'
   ```

   **В Git Bash / Linux / macOS**:
   ```bash
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -H "Content-Type: application/json" -d '{"url":"https://твой-сервис.up.railway.app/webhook","secret_token":"<ТВОЙ_WEBHOOK_SECRET>","allowed_updates":["message","callback_query","edited_message"]}'
   ```

   Значение `secret_token` должно совпадать с переменной `WEBHOOK_SECRET` в Railway.

4. Проверка: напиши боту в Telegram. Бот должен ответить. Открой `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo` и убедись, что в `allowed_updates` есть `callback_query`.

---

### Шаг 8. Если что-то пошло не так

- **«src refspec main does not match any» при push:** значит, либо нет ни одного коммита, либо ветка называется не `main`. Выполни: `git add .` → `git commit -m "Initial"` → `git branch` → `git push -u origin master` или `git push -u origin main`. В URL репозитория должен быть **username**, не email.
- **«remote: Repository not found» при push:** remote `origin` указывает на неверный URL (с email). Исправь: `git remote set-url origin https://github.com/segalisin21/orlyatnik-bot.git` (подставь свой username), затем снова `git push -u origin master`.
- **Бот не отвечает:** проверь логи (Railway → Deployments → View Logs). Убедись, что `getWebhookInfo` показывает твой URL и что запросы доходят (можно временно добавить логирование в `index.ts`).
- **Ошибки Google Sheets / «Requested entity was not found» в логах (в т.ч. из cron):**
  1. **GOOGLE_SHEET_ID** в Railway должен быть **только ID таблицы**, без URL и без `gid`. Из ссылки `https://docs.google.com/spreadsheets/d/1ZJwu-iTiVknAQUmPmhIZQhejA5cXBlumv6a4mA2Z2M0/edit?gid=341077838` нужна только часть `1ZJwu-iTiVknAQUmPmhIZQhejA5cXBlumv6a4mA2Z2M0`.
  2. Имена листов (вкладок) в таблице должны быть **точно** «Участники» (первый лист) и «Логи» — как в коде, без лишних пробелов.
  3. Таблицу нужно **расшарить** с сервис-аккаунтом: в Google-таблице «Настройки доступа» → добавить email из JSON ключа (вид `...@....iam.gserviceaccount.com`) с правом **Редактор**.
  После правок пересохрани переменные в Railway и при необходимости сделай Redeploy.
- **Ошибки Google Sheets (общее):** проверь заголовки листа «Участники» как в шаге 2.
- **Ошибки OpenAI:** проверь баланс и корректность `OPENAI_API_KEY`.
- Смена домена или редеплой: после смены URL снова вызови `setWebhook` с новым адресом.
- **Кнопка «Подтвердить» не реагирует:** проверь, что webhook установлен с `allowed_updates`, включающим `callback_query`. Вызови `getWebhookInfo` — если в списке нет `callback_query`, переустанови webhook командой выше.

---

## Деплой на Railway (кратко)

1. Создайте проект в [Railway](https://railway.app), подключите репозиторий.
2. В настройках сервиса:
   - **Build Command:** `npm run build` (или `npx tsc`)
   - **Start Command:** `node dist/index.js`
   - **Root Directory:** корень репозитория
3. Добавьте все переменные окружения из раздела «Настройка» (включая `GOOGLE_SHEETS_CREDENTIALS` и `BOT_TOKEN`).
4. Включите публичный домен и задайте URL для webhook (см. выше).
5. После деплоя вызовите `setWebhook` с итоговым URL.

## Поведение бота

- **Состояния (FSM):** NEW → INFO → FORM_FILLING → FORM_CONFIRM → WAIT_PAYMENT → PAYMENT_SENT → CONFIRMED.
- Регистрация закрыта — бот всегда говорит актуальную информацию и не соглашается с «я где-то видел другое».
- Голосовые сообщения транскрибируются через Whisper и обрабатываются как текст.
- Фото/документ в режиме ожидания оплаты считаются чеком: сохраняется `file_id`, админу уходит уведомление с анкетой и чеком.
- Подтверждение: админ выставляет в таблице статус `CONFIRMED`; раз в 2 минуты cron находит таких пользователей без `final_sent_at`, отправляет финальное сообщение (чат + контакт Кристины) и проставляет `final_sent_at`.

## Промпты и логика ведения клиента

### Логика по шагам

1. **NEW / INFO** — пользователь только пишет. Бот отвечает через **Sales-промпт** (консультация, база знаний), подводит к «Хочу забронировать». При фразах вроде «хочу забронировать» / «записываюсь» статус → **FORM_FILLING**, бот просит первое пустое поле анкеты.
2. **FORM_FILLING / FORM_CONFIRM** — бот использует **Form-промпт**: LLM возвращает JSON с текстом ответа и полями анкеты из сообщения; поля сохраняются. Если анкета заполнена — показывается целиком, просим подтвердить («да» / «подтверждаю»).
3. **FORM_CONFIRM** + пользователь написал «да»/«подтверждаю» → **WAIT_PAYMENT**: выдаются реквизиты и просьба прислать чек (фото/документ).
4. **WAIT_PAYMENT / PAYMENT_SENT** — текстовые сообщения не меняют статус; фото/документ считаются чеком → **PAYMENT_SENT**, уведомление админу с кнопкой «Подтвердить».
5. **CONFIRMED** — финальный ответ: ссылка на чат и контакт менеджера (кнопка или cron).

### Админ/менеджер (ADMIN_CHAT_ID)

- Один аккаунт: тот, чей `user id` указан в `ADMIN_CHAT_ID`.
- **Обязательно:** напиши боту `/start` — без этого Telegram не даст боту слать тебе сообщения.
- Функции: получаешь уведомления о чеках (анкета + фото/документ) и кнопку **«✅ Подтвердить оплату»**. Нажал — бот сразу обновляет статус, отправляет участнику финал (чат + Кристина) и помечает в таблице. Либо можно вручную поставить в таблице `CONFIRMED` — cron раз в 2 минуты тоже отправит финал.

Переходы статусов заданы в `src/fsm.ts` и не зависят от формулировок в промптах.

### Где менять промпты

| Что менять | Файл | Что править |
|------------|------|-------------|
| **Тон и роль Sales-агента** (консультация, «живой организатор») | `src/llm.ts` | Константа `SALES_SYSTEM` (стр. ~55–59). Первое предложение — роль и тон; ниже подставляется база знаний. |
| **Факты для агента** (цены, даты, возражения, реквизиты) | `src/config.ts` | Объект `kb` — оттуда собирается блок знаний в `SALES_SYSTEM`. |
| **Form-агент** (заполнение анкеты, извлечение полей) | `src/llm.ts` | В функции `getFormModeReply`: переменная `systemForm` (стр. ~100–112) и `FORM_JSON_INSTRUCTION`. |
| **Подсказки по полям** («Напиши ФИО», «Из какого города?») | `src/bot.ts` | Объект `FIELD_PROMPTS` (стр. ~25–31). |
| **Реквизиты, инструкция после оплаты** | `src/config.ts` | `kb.PAYMENT_SBER`, `kb.AFTER_PAYMENT_INSTRUCTION` и др. |

После правок: `npm run build`, задеплой на Railway (или перезапуск локально).

## Лицензия

MIT
