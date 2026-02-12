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
2. Создай репозиторий на GitHub (или GitLab) и запушь код:
   ```bash
   git remote add origin https://github.com/ТВОЙ_ЛОГИН/orlyatnik-bot.git
   git push -u origin main
   ```
3. Зайди на [railway.app](https://railway.app), войди через GitHub.
4. **New Project** → **Deploy from GitHub repo** → выбери репозиторий с ботом.
5. Railway создаст сервис. Кликни по нему.

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
   | `ADMIN_CHAT_ID` | число, ID чата из шага 4 |
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
3. Установи webhook в Telegram. В терминале выполни (подставь свой токен, домен и секрет):
   ```bash
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -d "url=https://твой-сервис.up.railway.app/webhook" -d "secret_token=<ТВОЙ_WEBHOOK_SECRET>"
   ```
   Без секрета (менее безопасно):
   ```bash
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://твой-сервис.up.railway.app/webhook"
   ```
   Значение `secret_token` должно совпадать с переменной `WEBHOOK_SECRET` в Railway. Тогда Telegram будет присылать его в заголовке, и бот будет принимать только запросы от Telegram.

4. Проверка: напиши боту в Telegram. Бот должен ответить. Если нет — смотри логи в Railway и убедись, что webhook установлен: открой `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo`.

---

### Шаг 8. Если что-то пошло не так

- **Бот не отвечает:** проверь логи (Railway → Deployments → View Logs). Убедись, что `getWebhookInfo` показывает твой URL и что запросы доходят (можно временно добавить логирование в `index.ts`).
- **Ошибки Google Sheets:** проверь, что листы называются именно «Участники» и «Логи», заголовки как в шаге 2, и что email сервис-аккаунта добавлен в таблицу с правом Редактор.
- **Ошибки OpenAI:** проверь баланс и корректность `OPENAI_API_KEY`.
- Смена домена или редеплой: после смены URL снова вызови `setWebhook` с новым адресом.

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

## Лицензия

MIT
