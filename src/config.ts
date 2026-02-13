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
  /** One or more Telegram user IDs, comma-separated (e.g. "123,456"). Notifications and admin menu for all. */
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : 0,
  /** Parsed list of admin IDs. If ADMIN_CHAT_ID is "123,456", this is [123, 456]. */
  ADMIN_CHAT_IDS: (process.env.ADMIN_CHAT_ID ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0),
  MANAGER_TG_USERNAME: process.env.MANAGER_TG_USERNAME ?? 'krisis_pr',
  CHAT_INVITE_LINK: process.env.CHAT_INVITE_LINK ?? '',
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
} as const;

/** Knowledge base (later can be moved to CONFIG sheet) */
export const kb = {
  /** Тест: открытая регистрация на 1 марта */
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

/** True if chatId is one of the configured admins (ADMIN_CHAT_ID or comma-separated list). */
export function isAdmin(chatId: number): boolean {
  if (env.ADMIN_CHAT_IDS.length > 0) return env.ADMIN_CHAT_IDS.includes(chatId);
  return env.ADMIN_CHAT_ID !== 0 && chatId === env.ADMIN_CHAT_ID;
}
