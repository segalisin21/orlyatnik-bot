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
  MANAGER_TG_USERNAME: process.env.MANAGER_TG_USERNAME ?? 'krisis_pr',
  CHAT_INVITE_LINK: process.env.CHAT_INVITE_LINK ?? '',
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
} as const;

/** Knowledge base (later can be moved to CONFIG sheet) */
export const kb = {
  REGISTRATION_CLOSED: true,
  LOCATION: 'База в Чувашии, примерно в часе езды от Чебоксар. Трансфер из Чебоксар есть; из других городов трансфера нет. Точный адрес высылается только участникам после подтверждения.',
  DATES: 'Заезд 16–17, выезд 15.',
  WHAT_INCLUDED: 'Входит: проживание, питание, баня, вечеринки, квесты и игры, «орлики», фото/видео, атмосфера.',
  PRICE: 21_000,
  DEPOSIT: 10_000,
  PAYMENT_SBER: 'Сбер: 89050293388 — Кристина Владимировна. Комментарий к переводу не писать.',
  MANAGER_FOR_COMPLEX: 'Для сложных или нестандартных вопросов — пиши Кристине @krisis_pr',
  MEDIA_CHANNEL: 'https://t.me/orlyatnik',
  AFTER_PAYMENT_INSTRUCTION: 'После оплаты напиши в чате «оплатил(а)» и пришли сюда в бота чек (фото или документ).',
  DEFAULT_SHIFT: '1',
  OBJECTION_PRICE: 'Получается около 7000 ₽ в день с проживанием, питанием и всей движухой.',
  OBJECTION_SOLO: 'Большинство приезжают соло — компания найдётся.',
  OBJECTION_NO_ALCOHOL: 'Есть спорт, мафия, костёр, разговоры — не только тусовка.',
  OBJECTION_NO_COMPANY: 'Компанию найдёшь на месте.',
} as const;

export type Env = typeof env;
