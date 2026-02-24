# Орлятник 21+ — Полная документация проекта

**Версия:** 1.0  
**Дата:** 2025  
**Назначение:** Исчерпывающее описание кода, логики и использования Telegram-бота «Орлятник 21+».

---

## Содержание

1. [Обзор проекта](#1-обзор-проекта)
2. [Архитектура и структура](#2-архитектура-и-структура)
3. [Описание модулей и логики](#3-описание-модулей-и-логики)
4. [Исходный код (фрагменты)](#4-исходный-код-фрагменты)
5. [Инструкции для пользователей](#5-инструкции-для-пользователей)
6. [Развёртывание и конфигурация](#6-развёртывание-и-конфигурация)
7. [Полный исходный код](#7-полный-исходный-код)

---

## 1. Обзор проекта

### Назначение

Бот для лагеря «Орлятник 21+» выполняет:

- Консультирование: ответы на вопросы (цены, даты, локация, программа, что взять)
- Сбор анкеты: ФИО, город, дата рождения, с кем едет, телефон, особенности, смена
- Приём оплаты: задаток, чек (фото/документ), уведомление админа
- Подтверждение: кнопка «Подтвердить оплату» или ручное изменение статуса в таблице
- Выдача: ссылка на чат участников и контакт менеджера после подтверждения

### Технологический стек

- **Node.js 20+**, TypeScript
- **Grammy** — Telegram Bot API
- **Google Sheets API** — CRM, логи, настройки
- **OpenAI** — GPT-4o-mini (диалог) и Whisper (голос)
- **Express** — webhook-сервер
- **node-cron** — периодические задачи (финальные сообщения, напоминания)

### Структура проекта

```
c:\bot\
├── src/
│   ├── index.ts        # Точка входа, cron, webhook
│   ├── bot.ts          # Обработчики сообщений, админ-меню
│   ├── config.ts       # Переменные окружения, база знаний (kb)
│   ├── runtime-config.ts # Динамические настройки из листа «Настройки»
│   ├── fsm.ts          # Машина состояний (статусы участника)
│   ├── sheets.ts       # Работа с Google Sheets
│   ├── llm.ts          # Sales- и Form-промпты, OpenAI
│   ├── voice.ts        # Транскрипция голоса (Whisper)
│   └── logger.ts       # Логирование
├── scripts/
│   └── build-client-base.ts  # Сборка базы клиентов из CSV
├── package.json
├── tsconfig.json
└── README.md
```

---

## 2. Архитектура и структура

### Машина состояний (FSM)

Участник движется по цепочке статусов:

```
NEW → INFO → FORM_FILLING → FORM_CONFIRM → WAIT_PAYMENT → PAYMENT_SENT → CONFIRMED
```

| Статус        | Описание                                                                 |
|---------------|---------------------------------------------------------------------------|
| NEW           | Первое сообщение, ещё не задавал вопросы                                  |
| INFO          | Задавал вопросы, но не начал бронировать                                  |
| FORM_FILLING  | Начал заполнять анкету («хочу забронировать»)                             |
| FORM_CONFIRM  | Анкета заполнена, ожидает подтверждения («да» / «подтверждаю»)            |
| WAIT_PAYMENT  | Подтвердил анкету, ждёт оплаты и чек                                      |
| PAYMENT_SENT  | Отправил чек, ждёт подтверждения менеджером                               |
| CONFIRMED     | Менеджер подтвердил, участник в списке                                    |

Допустимые переходы заданы в `fsm.ts` (`VALID_TRANSITIONS`).

### Поток данных

1. **Сообщение пользователя** → Grammy (bot.ts)
2. **Участник** загружается из кэша или Google Sheets (fsm.getParticipant)
3. В зависимости от статуса: Sales-промпт (LLM) или Form-промпт (LLM)
4. Ответ → Sheets (updateUserFields), логи (appendLog)
5. Фото/документ в WAIT_PAYMENT → PAYMENT_SENT, уведомление админу

### Cron-задачи

- **Каждые 2 минуты:** поиск участников со статусом CONFIRMED и пустым `final_sent_at` → отправка «Ты в списке!» + ссылка на чат
- **Ежедневно в 10:00 МСК:** напоминания неактивным участникам (если не писали 2+ дня и не напоминали 7+ дней)

---

## 3. Описание модулей и логики

### 3.1 config.ts

- **env** — переменные окружения (BOT_TOKEN, OPENAI_API_KEY, GOOGLE_SHEET_ID, ADMIN_CHAT_ID и др.)
- **kb** — база знаний: цены, даты, локация, возражения, реквизиты, инструкции
- **isAdmin(chatId)** — проверка, является ли пользователь админом

### 3.2 runtime-config.ts

- Загружает ключи-значения из листа «Настройки» (A=ключ, B=значение)
- **getKb()** — объединяет значения из таблицы с дефолтами из config.kb
- **updateConfigKey(key, value)** — сохраняет ключ в таблицу и обновляет кэш
- **EDITABLE_KEYS** — список параметров, доступных для редактирования админом через бота

### 3.3 fsm.ts

- **STATUS** — константы статусов
- **getParticipant** — получить/создать участника (кэш + Sheets)
- **setParticipantStatus** — смена статуса с проверкой допустимых переходов
- **patchParticipant** — частичное обновление полей (без смены статуса)
- **isFormComplete**, **getNextEmptyField** — проверка заполненности анкеты
- **formatAnketa** — форматирование анкеты для вывода
- **isUpdateProcessed / markUpdateProcessed** — защита от дублей обновлений (LRU, TTL 24ч)

### 3.4 sheets.ts

- **getParticipantByUserId** — поиск участника по user_id
- **getOrCreateUser** — получить или создать строку в «Участники»
- **updateUserFields** — обновление полей участника
- **appendLog** — добавление записи в «Логи»
- **getParticipantsPendingFinalSend** — CONFIRMED без final_sent_at (для cron)
- **getParticipantsForBroadcast** — участники для рассылки (all / CONFIRMED / waiting)
- **getParticipantsForReminders** — неактивные участники для напоминаний
- **getConfigFromSheet / setConfigInSheet** — чтение/запись листа «Настройки»

### 3.5 llm.ts

- **getSalesReply(text)** — ответ на общий вопрос (консультация). System-промпт строится из kb: даты, цены, возражения, стиль.
- **getFormModeReply(text, status, anketa)** — заполнение анкеты. LLM возвращает JSON: `intent`, `reply_text`, `form_patch` (поля), `needs_confirmation`.

### 3.6 voice.ts

- **transcribeVoice(fileId, getFile)** — скачивание голосового сообщения и транскрипция через Whisper API

### 3.7 bot.ts — Основная логика обработки

**Текстовые сообщения:**

1. Админ: /cancel, ввод рассылки, ввод настройки, /start, /admin
2. FORM_FILLING / FORM_CONFIRM: Form-промпт, сохранение полей, вывод анкеты
3. FORM_CONFIRM + «да»/«подтверждаю» → WAIT_PAYMENT, реквизиты
4. WAIT_PAYMENT / PAYMENT_SENT: просьба прислать чек
5. «оплатил»/«оплатила»: просьба прислать чек
6. «покажи анкету»: вывод анкеты
7. Иначе: Sales-промпт (LLM)
8. NEW → INFO при любом сообщении
9. PHRASE_BOOK («хочу забронировать») и не CONFIRMED → FORM_FILLING

**Голосовые сообщения:** транскрипция через Whisper, затем та же логика, что и для текста.

**Фото/документ:** в WAIT_PAYMENT → чек, PAYMENT_SENT, уведомление админу с кнопкой «Подтвердить».

**Callback (кнопки):**

- admin_broadcast, admin_br_* — рассылка
- admin_stats — статистика
- admin_settings, admin_set_* — настройки
- confirm_{userId} — подтверждение оплаты

### 3.8 index.ts

- `loadSheetConfig()` при старте
- `createBot()`
- Webhook или long-poll в зависимости от TELEGRAM_MODE
- Cron: финальные сообщения (каждые 2 мин), напоминания (ежедневно 10:00 МСК)

---

## 4. Исходный код

### package.json

```json
{
  "name": "orlyatnik-telegram-bot",
  "version": "1.0.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "client-base": "ts-node scripts/build-client-base.ts"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "grammy": "^1.28.0",
    "openai": "^4.52.0",
    "googleapis": "^140.0.0",
    "express": "^4.21.0",
    "node-cron": "^3.0.3"
  }
}
```

### src/config.ts

```typescript
export const env = {
  BOT_TOKEN: process.env.BOT_TOKEN ?? '',
  TELEGRAM_MODE: (process.env.TELEGRAM_MODE ?? 'long_poll') as 'webhook' | 'long_poll',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ?? '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  GOOGLE_SHEETS_CREDENTIALS: process.env.GOOGLE_SHEETS_CREDENTIALS ?? '',
  GOOGLE_SHEETS_CREDENTIALS_PATH: process.env.GOOGLE_SHEETS_CREDENTIALS_PATH ?? '',
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID ?? '',
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : 0,
  ADMIN_CHAT_IDS: (process.env.ADMIN_CHAT_ID ?? '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0),
  MANAGER_TG_USERNAME: process.env.MANAGER_TG_USERNAME ?? 'krisis_pr',
  CHAT_INVITE_LINK: process.env.CHAT_INVITE_LINK ?? '',
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
};

export const kb = {
  REGISTRATION_CLOSED: false,
  NEXT_SHIFT_TEXT: '1 марта (тест)',
  LOCATION: 'База в Чувашии, ~1 час от Чебоксар...',
  WHAT_INCLUDED: 'Проживание, питание, баня, вечеринки...',
  WHAT_TO_TAKE: 'Удобная одежда, купальник, документы...',
  PRICE: 21_000,
  DEPOSIT: 10_000,
  PAYMENT_SBER: 'Сбер: 89050293388 — Кристина Владимировна.',
  MEDIA_CHANNEL: 'https://t.me/orlyatnik',
  DEFAULT_SHIFT: '1 марта (тест)',
  OBJECTION_PRICE: 'Это 7000 ₽ в день...',
  OBJECTION_SOLO: 'Больше половины приезжают соло...',
  OBJECTION_NO_ALCOHOL: 'Есть спорт, мафия, костры...',
  OBJECTION_NO_COMPANY: 'Компания сама найдётся...',
  AFTER_PAYMENT_INSTRUCTION: 'После оплаты пришли чек...',
  // и др.
};

export function isAdmin(chatId: number): boolean {
  if (env.ADMIN_CHAT_IDS.length > 0) return env.ADMIN_CHAT_IDS.includes(chatId);
  return env.ADMIN_CHAT_ID !== 0 && chatId === env.ADMIN_CHAT_ID;
}
```

### src/fsm.ts (ключевые части)

```typescript
export const STATUS = {
  NEW: 'NEW',
  INFO: 'INFO',
  FORM_FILLING: 'FORM_FILLING',
  FORM_CONFIRM: 'FORM_CONFIRM',
  WAIT_PAYMENT: 'WAIT_PAYMENT',
  PAYMENT_SENT: 'PAYMENT_SENT',
  CONFIRMED: 'CONFIRMED',
};

const VALID_TRANSITIONS: Record<string, Status[]> = {
  [STATUS.NEW]: [STATUS.INFO, STATUS.FORM_FILLING],
  [STATUS.INFO]: [STATUS.FORM_FILLING],
  [STATUS.FORM_FILLING]: [STATUS.FORM_CONFIRM],
  [STATUS.FORM_CONFIRM]: [STATUS.WAIT_PAYMENT],
  [STATUS.WAIT_PAYMENT]: [STATUS.PAYMENT_SENT],
  [STATUS.PAYMENT_SENT]: [STATUS.CONFIRMED],
  [STATUS.CONFIRMED]: [],
};

export const FORM_FIELDS = ['fio', 'city', 'dob', 'companions', 'phone', 'shift'] as const;
```

### src/bot.ts (ключевые константы)

```typescript
const PHRASE_BOOK = /(хочу|готов|давай)\s*(забронировать|записаться|участвовать|ехать)|бронирую|записываюсь|.../i;
const PHRASE_CONFIRM_ANKETA = /^(да|подтверждаю|ок|всё верно|...)$/i;
const PHRASE_HINT_RECEIPT = '👉 Чтобы подтвердить оплату, пришли чек (фото или документ) сюда в бота';
```

### src/sheets.ts (интерфейс Participant)

```typescript
export interface Participant {
  user_id: string;
  username: string;
  chat_id: string;
  status: string;
  fio: string;
  city: string;
  dob: string;
  companions: string;
  phone: string;
  comment: string;
  shift: string;
  payment_proof_file_id: string;
  final_sent_at: string;
  updated_at: string;
  created_at: string;
  last_reminder_at?: string;
}
```

---

## 5. Инструкции для пользователей

### Для участников (клиентов)

1. **Вопросы:** пишите текстом или голосом — бот ответит.
2. **Бронь:** напишите «Хочу забронировать» или «Готов забронировать».
3. **Анкета:** бот задаст вопросы по очереди (ФИО, город, дата рождения, с кем едет, телефон, особенности, смена).
4. **Подтверждение:** напишите «Да» или «Подтверждаю» — получите реквизиты для оплаты.
5. **Оплата:** переведите задаток, затем пришлите **чек** (фото или документ) боту.
6. **Подтверждение менеджером:** после подтверждения получите сообщение «Ты в списке!» и ссылку на чат участников.
7. **После подтверждения:** можно продолжать задавать вопросы (смены, что взять и т.д.).

### Для админов

1. **Вход:** напишите боту `/start` или `/admin`.
2. **Рассылка:** кнопка «📢 Рассылка» → выбор аудитории (всем / подтверждённые / ждут оплаты) → ввод текста одним сообщением. Отмена: `/cancel`.
3. **Статистика:** кнопка «📊 Статистика» — количество участников по категориям.
4. **Настройки:** кнопка «⚙ Настройки» → выбор параметра → ввод нового значения. Значения сохраняются в лист «Настройки».
5. **Подтверждение оплаты:** под сообщением о чеке нажмите «✅ Подтвердить оплату».

---

## 6. Развёртывание и конфигурация

### Переменные окружения

| Переменная | Описание |
|------------|----------|
| BOT_TOKEN | Токен от @BotFather |
| TELEGRAM_MODE | `long_poll` или `webhook` |
| WEBHOOK_SECRET | Секрет для проверки webhook (опционально) |
| OPENAI_API_KEY | Ключ OpenAI |
| GOOGLE_SHEETS_CREDENTIALS | JSON ключа сервис-аккаунта (в одну строку) |
| GOOGLE_SHEET_ID | ID Google-таблицы |
| ADMIN_CHAT_ID | ID админа (или несколько через запятую) |
| MANAGER_TG_USERNAME | @username менеджера |
| CHAT_INVITE_LINK | Ссылка на чат участников |
| PORT | Порт HTTP-сервера (по умолчанию 3000) |

### Структура Google-таблицы

- **Участники:** user_id, username, chat_id, status, fio, city, dob, companions, phone, comment, shift, payment_proof_file_id, final_sent_at, updated_at, created_at, last_reminder_at
- **Логи:** timestamp, user_id, status, direction, message_type, text_preview, raw_json
- **Настройки:** A=ключ, B=значение (необязательный лист)

### Webhook (продакшен)

```
POST https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
Body: {"url":"https://ваш-домен.railway.app/webhook","secret_token":"...","allowed_updates":["message","callback_query","edited_message"]}
```

### Запуск

```bash
npm install
npm run build
npm start
```

---

## Скрипт сборки базы клиентов (build-client-base.ts)

Читает два CSV (чаты и Орлятник), объединяет по username и выводит `client-base.csv` с категориями:

- **participated** — участник с указанной сменой
- **filled_anketa** — заполнил анкету, смена не указана
- **just_wrote** — только переписка

Запуск: `npm run client-base` или `npx ts-node scripts/build-client-base.ts [путь_чаты.csv] [путь_орлятник.csv]`

---

## 7. Полный исходный код

### src/config.ts

```typescript
/**
 * Central config: env vars and knowledge base for Orlyatnik 21+
 */

export const env = {
  BOT_TOKEN: process.env.BOT_TOKEN ?? '',
  TELEGRAM_MODE: (process.env.TELEGRAM_MODE ?? 'long_poll') as 'webhook' | 'long_poll',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ?? '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  GOOGLE_SHEETS_CREDENTIALS: process.env.GOOGLE_SHEETS_CREDENTIALS ?? '',
  GOOGLE_SHEETS_CREDENTIALS_PATH: process.env.GOOGLE_SHEETS_CREDENTIALS_PATH ?? '',
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID ?? '',
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : 0,
  ADMIN_CHAT_IDS: (process.env.ADMIN_CHAT_ID ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0),
  MANAGER_TG_USERNAME: process.env.MANAGER_TG_USERNAME ?? 'krisis_pr',
  CHAT_INVITE_LINK: process.env.CHAT_INVITE_LINK ?? '',
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
} as const;

export const kb = {
  REGISTRATION_CLOSED: false,
  NEXT_SHIFT_TEXT: '1 марта (тест)',
  LOCATION: 'База в Чувашии, ~1 час от Чебоксар. Есть трансфер из Чебоксар до базы и парковка. Из других городов трансфер не организуем. Заезд 16–17:00, выезд 15:00. Точный адрес даём только участникам в чате.',
  DATES: 'Заезд 16–17:00, выезд 15:00.',
  WHAT_INCLUDED: 'Проживание в уютных корпусах с отоплением, полное питание (завтраки, обеды, ужины), баня, вечеринки и рейвы с диджеями, квесты/игры/конкурсы/speed dating, внутренняя валюта «орлики», фото и видео со смены, атмосфера и команда «своих».',
  WHAT_TO_TAKE: 'Удобная одежда (днём/вечером), купальник/шорты, спортивная обувь + сменка, документы, зарядка для телефона, средства гигиены, настроение.',
  PRICE: 21_000,
  DEPOSIT: 10_000,
  PAYMENT_SBER: 'Сбер: 89050293388 — Кристина Владимировна. Никаких комментариев при переводе указывать не нужно.',
  MANAGER_FOR_COMPLEX: 'Для сложных или нестандартных вопросов — пиши Кристине @krisis_pr. Если просят связать с человеком — давай ссылку на Кристину.',
  MEDIA_CHANNEL: 'https://t.me/orlyatnik',
  AFTER_PAYMENT_INSTRUCTION: 'После оплаты пришли чек (фото или документ) сюда в бота — это обязательно для подтверждения. Без чека не смогу принять и передать менеджеру. Когда менеджер подтвердит — пришлём ссылку на чат и контакт Кристины (@krisis_pr).',
  DEFAULT_SHIFT: '1 марта (тест)',
  OBJECTION_PRICE: 'Это 7000 ₽ в день с проживанием, питанием, кальянами и всей движухой. Дешевле, чем отель без атмосферы 😎',
  OBJECTION_SOLO: 'Больше половины приезжают соло. К утру субботы у тебя уже будет своя компания.',
  OBJECTION_NO_ALCOHOL: 'Есть спорт, мафия, костры, разговоры по душам. Не обязательно пить, чтобы кайфануть.',
  OBJECTION_NO_COMPANY: 'Компания сама найдётся, у нас вайб такой — никто не остаётся в стороне.',
} as const;

export type Env = typeof env;

export function isAdmin(chatId: number): boolean {
  if (env.ADMIN_CHAT_IDS.length > 0) return env.ADMIN_CHAT_IDS.includes(chatId);
  return env.ADMIN_CHAT_ID !== 0 && chatId === env.ADMIN_CHAT_ID;
}
```

### src/logger.ts

```typescript
/**
 * Structured console logger for Railway
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const entry = {
    level,
    message,
    ...(meta && Object.keys(meta).length > 0 ? meta : {}),
    timestamp: new Date().toISOString(),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
};
```

### src/fsm.ts

```typescript
/**
 * State machine: status transitions and persistence (Sheets + in-memory cache).
 */

import type { Participant } from './sheets.js';
import { getOrCreateUser, getParticipantByUserId, updateUserFields } from './sheets.js';
import { logger } from './logger.js';

export const STATUS = {
  NEW: 'NEW',
  INFO: 'INFO',
  FORM_FILLING: 'FORM_FILLING',
  FORM_CONFIRM: 'FORM_CONFIRM',
  WAIT_PAYMENT: 'WAIT_PAYMENT',
  PAYMENT_SENT: 'PAYMENT_SENT',
  CONFIRMED: 'CONFIRMED',
} as const;

export type Status = (typeof STATUS)[keyof typeof STATUS];

const VALID_TRANSITIONS: Record<string, Status[]> = {
  [STATUS.NEW]: [STATUS.INFO, STATUS.FORM_FILLING],
  [STATUS.INFO]: [STATUS.FORM_FILLING],
  [STATUS.FORM_FILLING]: [STATUS.FORM_CONFIRM],
  [STATUS.FORM_CONFIRM]: [STATUS.WAIT_PAYMENT],
  [STATUS.WAIT_PAYMENT]: [STATUS.PAYMENT_SENT],
  [STATUS.PAYMENT_SENT]: [STATUS.CONFIRMED],
  [STATUS.CONFIRMED]: [],
};

export function canTransition(from: string, to: Status): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

const userCache = new Map<number, Participant>();

export async function getParticipant(userId: number, username: string, chatId: number): Promise<Participant> {
  let p = userCache.get(userId);
  if (!p) {
    p = await getOrCreateUser(userId, username, chatId);
    userCache.set(userId, p);
  }
  return p;
}

export async function setParticipantStatus(
  userId: number,
  newStatus: Status,
  patch?: Partial<Omit<Participant, 'user_id' | 'rowIndex'>>
): Promise<Participant> {
  const p = userCache.get(userId);
  const currentStatus = p?.status ?? 'NEW';
  if (!canTransition(currentStatus, newStatus)) {
    logger.warn('FSM invalid transition ignored', { userId, from: currentStatus, to: newStatus });
    const existing = p ?? (await getParticipantByUserId(userId));
    if (existing) return existing;
    throw new Error(`Participant not found: ${userId}`);
  }
  const updated = await updateUserFields(userId, { status: newStatus, ...patch });
  userCache.set(userId, updated);
  return updated;
}

export async function patchParticipant(
  userId: number,
  patch: Partial<Omit<Participant, 'user_id' | 'rowIndex'>>
): Promise<Participant> {
  const updated = await updateUserFields(userId, patch);
  userCache.set(userId, updated);
  return updated;
}

export function invalidateCache(userId: number): void {
  userCache.delete(userId);
}

const PROCESSED_TTL_MS = 24 * 60 * 60 * 1000;
const processedUpdates = new Map<number, number>();

function cleanProcessed(): void {
  const now = Date.now();
  for (const [id, ts] of processedUpdates.entries()) {
    if (now - ts > PROCESSED_TTL_MS) processedUpdates.delete(id);
  }
}

export function isUpdateProcessed(updateId: number): boolean {
  cleanProcessed();
  return processedUpdates.has(updateId);
}

export function markUpdateProcessed(updateId: number): void {
  processedUpdates.set(updateId, Date.now());
}

export const FORM_FIELDS = ['fio', 'city', 'dob', 'companions', 'phone', 'shift'] as const;
export type FormField = (typeof FORM_FIELDS)[number];

export function isFormComplete(p: Participant): boolean {
  return FORM_FIELDS.every((f) => (p[f] ?? '').trim() !== '');
}

export function getNextEmptyField(p: Participant): FormField | null {
  for (const f of FORM_FIELDS) {
    if ((p[f] ?? '').trim() === '') return f;
  }
  return null;
}

export function formatAnketa(p: Participant): string {
  const lines = [
    `ФИО: ${p.fio || '—'}`,
    `Город: ${p.city || '—'}`,
    `Дата рождения: ${p.dob || '—'}`,
    `С кем едет: ${p.companions || '—'}`,
    `Телефон: ${p.phone || '—'}`,
    `Особенности/аллергии: ${p.comment || '—'}`,
    `Смена: ${p.shift || '—'}`,
  ];
  return lines.join('\n');
}
```

### src/runtime-config.ts

```typescript
/**
 * Runtime config: merged defaults (config.kb) + Google Sheet "Настройки".
 */

import { kb } from './config.js';
import { getConfigFromSheet, setConfigInSheet } from './sheets.js';
import type { FormField } from './fsm.js';

let sheetCache: Record<string, string> = {};

export interface RuntimeKb {
  REGISTRATION_CLOSED: boolean;
  NEXT_SHIFT_TEXT: string;
  LOCATION: string;
  DATES: string;
  WHAT_INCLUDED: string;
  WHAT_TO_TAKE: string;
  PRICE: number;
  DEPOSIT: number;
  PAYMENT_SBER: string;
  MANAGER_FOR_COMPLEX: string;
  MEDIA_CHANNEL: string;
  AFTER_PAYMENT_INSTRUCTION: string;
  DEFAULT_SHIFT: string;
  OBJECTION_PRICE: string;
  OBJECTION_SOLO: string;
  OBJECTION_NO_ALCOHOL: string;
  OBJECTION_NO_COMPANY: string;
  field_prompts: Record<FormField, string>;
}

const DEFAULT_FIELD_PROMPTS: Record<FormField, string> = {
  fio: 'Напиши, пожалуйста, ФИО (как в паспорте).',
  city: 'Из какого ты города?',
  dob: 'Дата рождения? (можно в любом формате)',
  companions: 'С кем едешь? (один/одна, вдвоём, думаешь — напиши как есть)',
  phone: 'Номер телефона для связи?',
  shift: 'Какая смена? (если не знаешь — напиши «по умолчанию»)',
};

const NUM_KEYS = new Set(['PRICE', 'DEPOSIT']);
const BOOL_KEYS = new Set(['REGISTRATION_CLOSED']);
const FIELD_PROMPT_PREFIX = 'FIELD_PROMPT_';

function parseValue(key: string, raw: string): string | number | boolean {
  if (NUM_KEYS.has(key)) {
    const n = Number(raw.replace(/\s/g, ''));
    return Number.isFinite(n) ? n : (kb as Record<string, unknown>)[key] as number;
  }
  if (BOOL_KEYS.has(key)) {
    return /^(1|true|да|yes)$/i.test(raw.trim());
  }
  return raw;
}

export async function loadSheetConfig(): Promise<void> {
  try {
    sheetCache = await getConfigFromSheet();
  } catch {
    sheetCache = {};
  }
}

export function getKb(): RuntimeKb {
  const base = { ...kb } as Record<string, unknown>;
  const fieldPrompts = { ...DEFAULT_FIELD_PROMPTS };

  for (const [key, raw] of Object.entries(sheetCache)) {
    if (!raw || raw.trim() === '') continue;
    if (key.startsWith(FIELD_PROMPT_PREFIX)) {
      const field = key.slice(FIELD_PROMPT_PREFIX.length) as FormField;
      if (field in fieldPrompts) fieldPrompts[field] = raw.trim();
    } else if (key in base) {
      base[key] = parseValue(key, raw);
    }
  }

  return { ...base, field_prompts: fieldPrompts } as RuntimeKb;
}

export async function updateConfigKey(key: string, value: string): Promise<void> {
  await setConfigInSheet(key, value);
  sheetCache[key] = value;
}

export const EDITABLE_KEYS: { key: string; label: string }[] = [
  { key: 'NEXT_SHIFT_TEXT', label: 'Ближайшая смена (даты)' },
  { key: 'DEFAULT_SHIFT', label: 'Смена по умолчанию' },
  { key: 'PRICE', label: 'Цена (₽)' },
  { key: 'DEPOSIT', label: 'Задаток (₽)' },
  { key: 'PAYMENT_SBER', label: 'Реквизиты Сбер' },
  { key: 'LOCATION', label: 'Локация' },
  { key: 'WHAT_INCLUDED', label: 'Что входит' },
  { key: 'WHAT_TO_TAKE', label: 'Что взять с собой' },
  { key: 'OBJECTION_PRICE', label: 'Возражение: дорого' },
  { key: 'OBJECTION_SOLO', label: 'Возражение: один' },
  { key: 'OBJECTION_NO_ALCOHOL', label: 'Возражение: не пью' },
  { key: 'OBJECTION_NO_COMPANY', label: 'Возражение: нет компании' },
  { key: 'MEDIA_CHANNEL', label: 'Ссылка на фото/видео' },
  { key: 'AFTER_PAYMENT_INSTRUCTION', label: 'Инструкция после оплаты' },
  { key: 'FIELD_PROMPT_fio', label: 'Вопрос: ФИО' },
  { key: 'FIELD_PROMPT_city', label: 'Вопрос: город' },
  { key: 'FIELD_PROMPT_dob', label: 'Вопрос: дата рождения' },
  { key: 'FIELD_PROMPT_companions', label: 'Вопрос: с кем едешь' },
  { key: 'FIELD_PROMPT_phone', label: 'Вопрос: телефон' },
  { key: 'FIELD_PROMPT_shift', label: 'Вопрос: смена' },
];
```

### src/voice.ts

```typescript
/**
 * Voice: download file from Telegram, transcribe via Whisper.
 */

import OpenAI from 'openai';
import { env } from './config.js';
import { logger } from './logger.js';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export type GetFileFn = (fileId: string) => Promise<{ href: string }>;

export async function transcribeVoice(fileId: string, getFile: GetFileFn): Promise<string> {
  try {
    const file = await getFile(fileId);
    const url = file.href;
    if (!url) {
      logger.warn('Voice: no href from getFile', { fileId });
      return '';
    }
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn('Voice: fetch failed', { fileId, status: response.status });
      return '';
    }
    const buffer = await response.arrayBuffer();
    const blob = new Blob([buffer], { type: 'audio/ogg' });
    const form = new FormData();
    form.append('file', blob, 'voice.ogg');
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.error('Whisper API error', { status: res.status, body: errText });
      return '';
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
  } catch (e) {
    logger.error('Transcribe error', { fileId, error: String(e) });
    return '';
  }
}
```

### src/llm.ts

```typescript
/**
 * LLM layer: Sales/Support (text) and Form (structured JSON). OpenAI Chat Completions.
 */

import OpenAI from 'openai';
import { env } from './config.js';
import { getKb } from './runtime-config.js';
import { logger } from './logger.js';
import type { Participant } from './sheets.js';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export type Intent = 'INFO' | 'BOOK' | 'UPDATE_FORM' | 'PAYMENT' | 'OTHER';

export interface FormPatch {
  fio?: string;
  city?: string;
  dob?: string;
  companions?: string;
  phone?: string;
  comment?: string;
  shift?: string;
}

export interface FormModeOutput {
  intent: Intent;
  reply_text: string;
  form_patch: FormPatch;
  next_status?: string;
  needs_confirmation?: boolean;
}

const FORM_JSON_INSTRUCTION = `Ответь ТОЛЬКО одним JSON-объектом без markdown и комментариев. Формат:
{"intent":"INFO|BOOK|UPDATE_FORM|PAYMENT|OTHER","reply_text":"...","form_patch":{...},"needs_confirmation":true|false}
form_patch — только поля, извлечённые из сообщения (fio, city, dob, companions, phone, comment, shift).`;

function buildSalesSystem(): string {
  const kb = getKb();
  return `Ты — живой и включённый организатор лагеря Орлятник 21+ 🏕
Ты не бот, а будто реальный человек, которому самому кайфово от этой движухи. Отвечай легко, с юмором, но уважительно. Следи за контекстом: не повторяйся, если уже что-то обсудили (тебе приходит последнее сообщение пользователя).

📌 Твои задачи

Отвечай на вопросы максимально конкретно: даты, цена, программа, место, что входит, что взять с собой.

Мягко и уверенно отрабатывай возражения:

«Дорого» → «${kb.OBJECTION_PRICE}»

«Боюсь ехать один/одна» → «${kb.OBJECTION_SOLO}»

«Я не пью / не тусовый» → «${kb.OBJECTION_NO_ALCOHOL}»

«Нет компании» → «${kb.OBJECTION_NO_COMPANY}»

«Ничего не знаю, расскажи» → всегда выдавай яркий, вдохновляющий рассказ с акцентом на атмосферу.

Подводи к бронированию: когда человек готов — скажи: «Напиши «Хочу забронировать» или «Готов забронировать» — и я начну сбор анкеты». Важно: бот переключает статус только по этим фразам.

После согласия бот сам соберёт анкету (ФИО, город, дата рождения, с кем едет, телефон, особенности/аллергии, смена). Если человек что-то меняет — выводи всю анкету целиком для подтверждения.

После анкеты → предложи оплатить задаток ${kb.DEPOSIT} ₽ на Сбер: ${kb.PAYMENT_SBER}

В сообщении об оплате показывай всю заполненную анкету + выбранную смену пользователю.

После оплаты → поздравь и переведи человека в чат к Кристине (@krisis_pr). Попроси подтвердить, что оплатил: написать в чате «оплатил» или «оплатила» — это важно!

Данные автоматически пишутся в Google Sheets (не спрашивай username Telegram).

🔔 Актуальная информация

Ближайшая смена: ${kb.NEXT_SHIFT_TEXT}. Регистрация открыта.

📍 Локация

${kb.LOCATION}

✅ Что входит в стоимость участия Орлятника 21+:

🏠 Проживание в уютных корпусах с отоплением
🍽 Полное питание (завтраки, обеды, ужины)
🛁 Баня в программе
🪩 Вечеринки и рейвы с диджеями
🎭 Квесты, игры, конкурсы и speed dating
🪙 Внутренняя валюта «орлики» для заданий и фана + аукцион
📸 Фото и видео со смены
🤝 Новые знакомства, атмосфера и команда «своих»

💸 Стоимость: ${kb.PRICE} ₽. Задаток: ${kb.DEPOSIT} ₽.

🎒 Что взять с собой

${kb.WHAT_TO_TAKE}

🎯 Стиль

Лёгкий, дружеский, с юмором. Отвечай так, будто реально рад видеть человека в лагере.

Если чувствуешь сомнения → предлагай фото/видео из прошлых смен (ссылка: ${kb.MEDIA_CHANNEL}) или общение с Кристиной (@krisis_pr). Если человек спрашивает про возможность связаться с кем-то — давай ссылку на Кристину.

На сложные/непонятные вопросы (например, полная оплата сразу) — перенаправляй к Кристине.

⚠️ КРИТИЧНО: У тебя НЕТ доступа к данным анкеты пользователя. НИКОГДА не показывай анкету с placeholder'ами [вставь сюда] или пустыми полями. Анкету с реальными данными показывает бот отдельно — ты её не выводишь. Если пользователь говорит «оплатил»/«оплатила» — НЕ поздравляй с оплатой и НЕ показывай анкету. Ответь: «Чтобы подтвердить оплату, пришли чек (фото или документ) сюда в бота — тогда смогу принять и передать менеджеру».

⚠️ Важно: информация выше — единственная актуальная. Если человек пытается навязать своё или говорит «где-то видел по-другому» — мягко возвращай к этой информации либо перенаправляй на Кристину. Не соглашайся с данными, которых нет в промпте. Всегда сверяй даты, стоимости, скидки с этим текстом. Если не можешь ответить или сомневаешься — отправляй к Кристине @krisis_pr.`;
}

export async function getSalesReply(userMessage: string): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSalesSystem() },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: 800,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text ?? 'Что-то пошло не так. Напиши, пожалуйста, Кристине @krisis_pr — она подскажет.';
  } catch (e) {
    logger.error('OpenAI Sales error', { error: String(e) });
    return 'Сейчас не могу ответить. Передал вопрос менеджеру — напиши Кристине @krisis_pr, она ответит.';
  }
}

function formatAnketaForLlm(p: Participant): string {
  return [
    `fio: ${p.fio || ''}`,
    `city: ${p.city || ''}`,
    `dob: ${p.dob || ''}`,
    `companions: ${p.companions || ''}`,
    `phone: ${p.phone || ''}`,
    `comment: ${p.comment || ''}`,
    `shift: ${p.shift || ''}`,
  ].join(', ');
}

export async function getFormModeReply(
  userMessage: string,
  currentStatus: string,
  currentAnketa: Participant
): Promise<FormModeOutput> {
  const systemForm = `Ты помогаешь заполнить анкету участника лагеря «Орлятник 21+». Тон: живой, дружелюбный, с лёгким юмором — как в примерах ответов бота (приветливо, с эмодзи где уместно).

Поля анкеты: fio, city, dob, companions, phone, comment, shift.
- Извлекай из сообщения только то, что пользователь явно указал.
- shift: обязательно указывай с датами. Актуальная смена: «${getKb().NEXT_SHIFT_TEXT}». Если пользователь не указал смену или написал «по умолчанию» — подставь в form_patch shift: «${getKb().NEXT_SHIFT_TEXT}», чтобы даты попали в базу.
- Если человек что-то меняет — в reply_text можешь кратко подтвердить; код выведет анкету целиком для подтверждения.

Ответь СТРОГО в формате JSON: intent, reply_text, form_patch, needs_confirmation (опционально).
- intent: INFO | BOOK | UPDATE_FORM | PAYMENT | OTHER
- reply_text: что сказать пользователю (коротко, в стиле организатора)
- form_patch: только поля, извлечённые из сообщения (или shift по умолчанию, если не указан)
- needs_confirmation: true если пользователь подтвердил анкету целиком («да», «подтверждаю», «всё верно»)

Текущая анкета: ${formatAnketaForLlm(currentAnketa)}
Текущий статус: ${currentStatus}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemForm + '\n\n' + FORM_JSON_INSTRUCTION },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 500,
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) {
      return {
        intent: 'OTHER',
        reply_text: 'Не удалось разобрать ответ. Напиши поле по одному или обратись к Кристине @krisis_pr.',
        form_patch: {},
      };
    }
    const parsed = JSON.parse(raw) as FormModeOutput;
    if (!parsed.reply_text) parsed.reply_text = 'Принято. Что-то ещё?';
    if (!parsed.form_patch) parsed.form_patch = {};
    return parsed;
  } catch (e) {
    logger.error('OpenAI Form error', { error: String(e) });
    return {
      intent: 'OTHER',
      reply_text: 'Сейчас не могу обработать. Попробуй ещё раз или напиши Кристине @krisis_pr.',
      form_patch: {},
    };
  }
}
```

### src/index.ts

```typescript
/**
 * Bootstrap: webhook or long-poll, HTTP server, cron for final messages.
 */

import express from 'express';
import cron from 'node-cron';
import { webhookCallback } from 'grammy';
import { env } from './config.js';
import { logger } from './logger.js';
import { loadSheetConfig } from './runtime-config.js';
import { createBot } from './bot.js';
import {
  getParticipantsPendingFinalSend,
  getParticipantsForReminders,
  updateUserFields,
} from './sheets.js';
import { invalidateCache } from './fsm.js';

let bot: ReturnType<typeof createBot>;

const REMINDER_INACTIVE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days without activity
const REMINDER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // don't remind same user more than once per 7 days

const REMINDER_BY_STATUS: Record<string, string> = {
  NEW: 'Привет! Ты спрашивал про Орлятник — хочешь продолжить? Напиши «хочу забронировать» или задай вопрос.',
  INFO: 'Привет! Ты спрашивал про Орлятник — хочешь продолжить? Напиши «хочу забронировать» или задай вопрос.',
  FORM_FILLING: 'Мы начали заполнять анкету — давай продолжим? Напиши следующий ответ или «подтверждаю», если всё верно.',
  FORM_CONFIRM: 'Мы начали заполнять анкету — давай продолжим? Напиши следующий ответ или «подтверждаю», если всё верно.',
  WAIT_PAYMENT: 'Напоминаем: чтобы подтвердить оплату, пришли чек (фото или документ) сюда в бота.',
  PAYMENT_SENT: 'Мы получили твой чек, менеджер скоро проверит. Если есть вопросы — пиши.',
};

async function sendFinalToParticipant(chatId: string, managerUsername: string, chatInviteLink: string): Promise<void> {
  const text = `Ты в списке!\n\nЧат участников: ${chatInviteLink || '—'}\nМенеджер: @${managerUsername}`;
  await bot.api.sendMessage(chatId, text);
}

async function cronJob(): Promise<void> {
  try {
    const list = await getParticipantsPendingFinalSend();
    for (const p of list) {
      try {
        await sendFinalToParticipant(p.chat_id, env.MANAGER_TG_USERNAME, env.CHAT_INVITE_LINK);
        const now = new Date().toISOString();
        await updateUserFields(Number(p.user_id), { final_sent_at: now });
        invalidateCache(Number(p.user_id));
        logger.info('Final message sent', { user_id: p.user_id });
      } catch (e) {
        logger.error('Cron: send final failed', { user_id: p.user_id, error: String(e) });
      }
    }
  } catch (e) {
    logger.error('Cron job error', { error: String(e) });
  }
}

async function reminderJob(): Promise<void> {
  try {
    const list = await getParticipantsForReminders(REMINDER_INACTIVE_MS, REMINDER_COOLDOWN_MS);
    const delayMs = 80;
    for (const p of list) {
      try {
        const text = REMINDER_BY_STATUS[p.status] ?? REMINDER_BY_STATUS.NEW;
        await bot.api.sendMessage(p.chat_id, text);
        const now = new Date().toISOString();
        await updateUserFields(Number(p.user_id), { last_reminder_at: now });
        invalidateCache(Number(p.user_id));
        logger.info('Reminder sent', { user_id: p.user_id, status: p.status });
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (e) {
        logger.error('Reminder send failed', { user_id: p.user_id, error: String(e) });
      }
    }
  } catch (e) {
    logger.error('Reminder job error', { error: String(e) });
  }
}

function startCron(): void {
  cron.schedule('*/2 * * * *', cronJob, { timezone: 'Europe/Moscow' });
  cron.schedule('0 10 * * *', reminderJob, { timezone: 'Europe/Moscow' });
  logger.info('Cron: final send every 2 min, reminders daily at 10:00 Moscow');
}

async function main(): Promise<void> {
  await loadSheetConfig();
  bot = createBot();

  if (env.TELEGRAM_MODE === 'webhook') {
    const app = express();
    app.use(express.json());
    app.post('/webhook', webhookCallback(bot, 'express', env.WEBHOOK_SECRET ? { secretToken: env.WEBHOOK_SECRET } : undefined));
    app.get('/health', (_req, res) => { res.status(200).send('ok'); });
    const port = env.PORT || 3000;
    app.listen(port, () => { logger.info('Webhook server listening', { port }); });
    startCron();
  } else {
    bot.start({ onStart: (info) => logger.info('Bot started', { username: info.username }) });
    startCron();
  }
}

main().catch((e) => {
  logger.error('Fatal', { error: String(e), stack: (e as Error).stack });
  process.exit(1);
});
```

### src/sheets.ts

Полный код: 410 строк. Основные функции: `getParticipantByUserId`, `getOrCreateUser`, `updateUserFields`, `appendLog`, `getParticipantsPendingFinalSend`, `getParticipantsForBroadcast`, `getParticipantsForReminders`, `getConfigFromSheet`, `setConfigInSheet`. Интерфейсы: `Participant`, `LogEntry`.

### src/bot.ts

Полный код: 590 строк. Обработчики: `callback_query` (admin, confirm), `message:text`, `message:voice`, `message:photo`, `message:document`. Константы: `PHRASE_BOOK`, `PHRASE_CONFIRM_ANKETA`, `PHRASE_HINT_*`.

### scripts/build-client-base.ts

Полный код: 224 строки. Функции: `parseChatyCsv`, `parseOrlyatnikCsv`, `parseCsvRow`, `escapeCsv`. Категории: participated, filled_anketa, just_wrote.

*(Полный исходный код всех файлов доступен в репозитории `c:\\bot\\`.)*

---

*Документ подготовлен автоматически. Актуальный код — в репозитории проекта.*
