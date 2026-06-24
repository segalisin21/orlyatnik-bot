/**
 * Runtime config: merged defaults (config.kb) + Google Sheet "Настройки".
 * Admin can edit values via bot; no code deploy needed.
 */

import { kb, kbPizhamnik, env } from './config.js';
import { getConfigFromSheet, setConfigInSheet } from './sheets.js';
import type { FormField } from './fsm.js';

let sheetCache: Record<string, string> = {};
let sheetCachePizhamnik: Record<string, string> = {};

export interface RuntimeKb {
  REGISTRATION_CLOSED: boolean;
  NEXT_SHIFT_TEXT: string;
  LOCATION: string;
  DATES: string;
  /** Главный контекст для ответов LLM (лист «Настройки»). */
  LLM_CONTEXT?: string;
  WHAT_INCLUDED: string;
  WHAT_TO_TAKE: string;
  PRICE: number;
  DEPOSIT: number;
  PAYMENT_SBER: string;
  MANAGER_FOR_COMPLEX: string;
  MANAGER_ELVIRA_USERNAME?: string;
  MANAGER_ELVIRA_URL?: string;
  MANAGER_KRISTINA_URL?: string;
  MEDIA_CHANNEL: string;
  AFTER_PAYMENT_INSTRUCTION: string;
  REVIEWS_BUTTON_LABEL?: string;
  REVIEWS_INTRO_TEXT?: string;
  REVIEWS_POST_URL?: string;
  CONDITIONS_PRICE_PHOTO?: string;
  CONDITIONS_TERMS_PHOTO?: string;
  PROGRAM_COVER_PHOTO?: string;
  CONFIRMED_CELEBRATION_PHOTO?: string;
  CONFIRMED_MESSAGE_TEXT?: string;
  CONFIRMED_MESSAGE_SHIFT_0?: string;
  CONFIRMED_MESSAGE_SHIFT_1?: string;
  LOOKS_REFERENCES_URL?: string;
  /** URL фото для кнопки «Узнать программу» (лист «Настройки»). */
  PROGRAM_PHOTO_1?: string;
  PROGRAM_PHOTO_2?: string;
  PROGRAM_PHOTO_3?: string;
  DEFAULT_SHIFT: string;
  AVAILABLE_SHIFTS: string;
  OBJECTION_PRICE: string;
  OBJECTION_SOLO: string;
  OBJECTION_NO_ALCOHOL: string;
  OBJECTION_NO_COMPANY: string;
  CONSENT_PD_TEXT: string;
  field_prompts: Record<FormField, string>;
  /** Pizhamnik-only */
  REMAINDER?: number;
  PLACES_LIMIT?: number;
  START_MESSAGE?: string;
  PROGRAM_TEXT?: string;
  CONDITIONS_TEXT?: string;
  PAYMENT_INSTRUCTION?: string;
  AFTER_RECEIPT_MESSAGE?: string;
  REFUND_DEADLINE_TEXT?: string;
  REMAINDER_REMINDER_TEXT?: string;
  PLACES_FULL_MESSAGE?: string;
  WAITLIST_CONFIRMED_MESSAGE?: string;
  CHECKIN_CHECKOUT?: string;
  EVENT_DATE?: string;
  /** Вторая путёвка Орлятник: подписи (лист «Настройки»). */
  SECOND_BOOKING_FINAL_BTN?: string;
  SECOND_BOOKING_WHO_PROMPT?: string;
  SECOND_BOOKING_SELF_BTN?: string;
  SECOND_BOOKING_OTHER_BTN?: string;
  /** Telegram chat_id для тестовой рассылки (через запятую). */
  BROADCAST_TEST_CHAT_IDS?: string;
}

/** Дефолты вопросов анкеты (лист «Настройки»: FIELD_PROMPT_*). */
export const DEFAULT_FIELD_PROMPTS: Record<FormField, string> = {
  fio: 'Супер! Давай знакомиться. Напиши своё ФИО полностью, как в паспорте — это нужно для базы отдыха.',
  city: 'Из какого ты города?',
  dob: 'Дата рождения? (можно в любом формате)',
  companions: 'С кем едешь? (один/одна, вдвоём, думаешь — напиши как есть)',
  phone: 'Номер телефона для связи?',
  comment: 'Есть ли особенности или аллергии, о которых важно знать? Если нет — напиши «нет» или «—».',
  shift: 'Какая смена? (можно выбрать из списка или написать дату)',
};

const NUM_KEYS = new Set(['PRICE', 'DEPOSIT', 'REMAINDER', 'PLACES_LIMIT']);
const BOOL_KEYS = new Set(['REGISTRATION_CLOSED']);
const FIELD_PROMPT_PREFIX = 'FIELD_PROMPT_';

function parseValue(key: string, raw: string, base: Record<string, unknown> = kb as Record<string, unknown>): string | number | boolean {
  if (NUM_KEYS.has(key)) {
    const n = Number(raw.replace(/\s/g, ''));
    return Number.isFinite(n) ? n : (base[key] as number) ?? 0;
  }
  if (BOOL_KEYS.has(key)) {
    return /^(1|true|да|yes)$/i.test(raw.trim());
  }
  return raw;
}

/** Load config from Google Sheets "Настройки" and "Настройки Пижамник". Call at startup. */
export async function loadSheetConfig(): Promise<void> {
  try {
    sheetCache = await getConfigFromSheet();
  } catch {
    sheetCache = {};
  }
  try {
    sheetCachePizhamnik = await getConfigFromSheet('pizhamnik');
  } catch {
    sheetCachePizhamnik = {};
  }
}

/** Get merged config for Orlyatnik: sheet overrides defaults. */
function getKbOrlyatnik(): RuntimeKb {
  const base = { ...kb } as Record<string, unknown>;
  const fieldPrompts = { ...DEFAULT_FIELD_PROMPTS };

  for (const [key, raw] of Object.entries(sheetCache)) {
    if (!raw || raw.trim() === '') continue;
    if (key.startsWith(FIELD_PROMPT_PREFIX)) {
      const field = key.slice(FIELD_PROMPT_PREFIX.length) as FormField;
      if (field in fieldPrompts) fieldPrompts[field] = raw.trim();
    } else if (key in base) {
      base[key] = parseValue(key, raw, base);
    }
  }

  return {
    ...base,
    field_prompts: fieldPrompts,
  } as RuntimeKb;
}

/** Get merged config for Pizhamnik: sheet "Настройки Пижамник" overrides defaults. */
function getKbPizhamnik(): RuntimeKb {
  const base = { ...kbPizhamnik } as Record<string, unknown>;
  const fieldPrompts = { ...DEFAULT_FIELD_PROMPTS };

  for (const [key, raw] of Object.entries(sheetCachePizhamnik)) {
    if (!raw || raw.trim() === '') continue;
    if (key.startsWith(FIELD_PROMPT_PREFIX)) {
      const field = key.slice(FIELD_PROMPT_PREFIX.length) as FormField;
      if (field in fieldPrompts) fieldPrompts[field] = raw.trim();
    } else if (key in base) {
      base[key] = parseValue(key, raw, base);
    }
  }

  return {
    ...base,
    field_prompts: fieldPrompts,
  } as RuntimeKb;
}

/** Get merged config by event. orlyatnik (or empty) = sheet overrides; pizhamnik = static Pizhamnik config. */
export function getKb(event?: string): RuntimeKb {
  if (event === 'pizhamnik') return getKbPizhamnik();
  return getKbOrlyatnik();
}

/** Нормализует подпись смены для сравнения (тире, пробелы, регистр). */
export function normalizeShiftLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[–—−‑]/g, '-')
    .replace(/\s+/g, ' ');
}

/** Индекс смены в AVAILABLE_SHIFTS или -1. */
export function findShiftIndex(shifts: string[], label: string): number {
  const key = normalizeShiftLabel(label);
  if (!key) return -1;
  return shifts.findIndex((s) => normalizeShiftLabel(s) === key);
}

/** List of available shifts (from AVAILABLE_SHIFTS, comma-separated). */
export function getShiftsList(event?: string): string[] {
  const raw = getKb(event).AVAILABLE_SHIFTS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const CONFIRMED_MESSAGE_FALLBACK =
  'Поздравляем! Регистрация прошла успешно! 🥂🥳 Твой задаток в размере 8 000 руб. зафиксирован. Ты официальный участник самого безумного «Шапито» этого лета!\n\n' +
  'Нас будет много — от 50 до 120 самых заряженных людей на одной волне. Общий чат участников мы создадим чуть позже, ссылка прилетит сюда.';

function confirmedMessageForShiftIndex(kb: Record<string, unknown>, index: number): string | null {
  if (index < 0) return null;
  const key = `CONFIRMED_MESSAGE_SHIFT_${index}`;
  const text = (kb[key] as string | undefined)?.trim();
  return text || null;
}

/** Текст поздравления после оплаты: по смене участника → CONFIRMED_MESSAGE_TEXT → дефолт из кода. */
export function getConfirmedMessageTextForShift(event: string, shift?: string): string {
  const kb = getKb(event) as unknown as Record<string, unknown>;
  const shifts = getShiftsList(event);

  const resolveByLabel = (label: string): string | null => {
    const trimmed = label.trim();
    if (!trimmed) return null;
    const index = findShiftIndex(shifts, trimmed);
    return confirmedMessageForShiftIndex(kb, index);
  };

  const byShift = resolveByLabel(shift ?? '');
  if (byShift) return byShift;

  if (!shift?.trim()) {
    const byDefault = resolveByLabel(String(kb.DEFAULT_SHIFT ?? ''));
    if (byDefault) return byDefault;
  }

  const generic = (kb.CONFIRMED_MESSAGE_TEXT as string | undefined)?.trim();
  return generic || CONFIRMED_MESSAGE_FALLBACK;
}

/** Parse comma-separated Telegram ids (sheet «Настройки» → BROADCAST_TEST_CHAT_IDS). */
export function parseBroadcastTestChatIds(raw: string | undefined): number[] {
  return (raw ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0);
}

/** Test broadcast recipients: sheet → env (legacy) → admins. */
export function getBroadcastTestChatIds(adminFallback: number[]): number[] {
  const fromSheet = parseBroadcastTestChatIds(getKb('orlyatnik').BROADCAST_TEST_CHAT_IDS);
  if (fromSheet.length > 0) return fromSheet;
  if (env.BROADCAST_TEST_CHAT_IDS.length > 0) return env.BROADCAST_TEST_CHAT_IDS;
  return adminFallback;
}

/** Save one key to sheet and refresh cache. event = 'pizhamnik' uses sheet "Настройки Пижамник". */
export async function updateConfigKey(key: string, value: string, event?: string): Promise<void> {
  await setConfigInSheet(key, value, event);
  if (event === 'pizhamnik') {
    sheetCachePizhamnik[key] = value;
  } else {
    sheetCache[key] = value;
  }
}

/** Keys admins can edit from the menu, with short labels. Даты и тексты берутся из листа «Настройки». */
export const EDITABLE_KEYS: { key: string; label: string }[] = [
  { key: 'LLM_CONTEXT', label: 'Контекст для LLM' },
  { key: 'DATES', label: 'Даты заезда/выезда' },
  { key: 'NEXT_SHIFT_TEXT', label: 'Ближайшая смена (даты)' },
  { key: 'DEFAULT_SHIFT', label: 'Смена по умолчанию' },
  { key: 'AVAILABLE_SHIFTS', label: 'Список смен (через запятую)' },
  { key: 'START_MESSAGE', label: 'Приветствие после выбора' },
  { key: 'PROGRAM_TEXT', label: 'Текст: программа (если нет фото)' },
  { key: 'PROGRAM_PHOTO_1', label: 'URL фото программы 1' },
  { key: 'PROGRAM_PHOTO_2', label: 'URL фото программы 2' },
  { key: 'PROGRAM_PHOTO_3', label: 'URL фото программы 3' },
  { key: 'PROGRAM_COVER_PHOTO', label: 'URL обложки программы' },
  { key: 'CONDITIONS_PRICE_PHOTO', label: 'URL инфографики: цены' },
  { key: 'CONDITIONS_TERMS_PHOTO', label: 'URL инфографики: условия' },
  { key: 'CONDITIONS_TEXT', label: 'Текст: условия и стоимость' },
  { key: 'REVIEWS_BUTTON_LABEL', label: 'Кнопка: отзывы (подпись)' },
  { key: 'REVIEWS_INTRO_TEXT', label: 'Текст: отзывы' },
  { key: 'REVIEWS_POST_URL', label: 'Ссылка на пост с отзывами' },
  { key: 'CONFIRMED_CELEBRATION_PHOTO', label: 'URL: поздравление после оплаты' },
  { key: 'CONFIRMED_MESSAGE_TEXT', label: 'Текст после оплаты (fallback)' },
  { key: 'CONFIRMED_MESSAGE_SHIFT_0', label: 'Текст после оплаты: 17–19 июля' },
  { key: 'CONFIRMED_MESSAGE_SHIFT_1', label: 'Текст после оплаты: 14–16 августа' },
  { key: 'LOOKS_REFERENCES_URL', label: 'Ссылка: идеи образов' },
  { key: 'MANAGER_ELVIRA_URL', label: 'Ссылка: Эльвира (личка)' },
  { key: 'MANAGER_KRISTINA_URL', label: 'Ссылка: Кристина (личка)' },
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
  { key: 'BROADCAST_TEST_CHAT_IDS', label: 'Тестовая рассылка: chat_id' },
  { key: 'MANAGER_FOR_COMPLEX', label: 'Контакты менеджеров (текст)' },
  { key: 'AFTER_PAYMENT_INSTRUCTION', label: 'Инструкция после оплаты' },
  { key: 'CONSENT_PD_TEXT', label: 'Текст согласия на обработку ПД' },
  { key: 'SECOND_BOOKING_FINAL_BTN', label: 'Кнопка: ещё путёвка (после списка)' },
  { key: 'SECOND_BOOKING_WHO_PROMPT', label: 'Текст: для себя или для другого' },
  { key: 'SECOND_BOOKING_SELF_BTN', label: 'Кнопка: для себя' },
  { key: 'SECOND_BOOKING_OTHER_BTN', label: 'Кнопка: для другого' },
  { key: 'FIELD_PROMPT_fio', label: 'Вопрос: ФИО' },
  { key: 'FIELD_PROMPT_city', label: 'Вопрос: город' },
  { key: 'FIELD_PROMPT_dob', label: 'Вопрос: дата рождения' },
  { key: 'FIELD_PROMPT_companions', label: 'Вопрос: с кем едешь' },
  { key: 'FIELD_PROMPT_phone', label: 'Вопрос: телефон' },
  { key: 'FIELD_PROMPT_shift', label: 'Вопрос: смена' },
];

/** Keys admins can edit for Pizhamnik (sheet "Настройки Пижамник"). Даты берутся из таблицы. */
export const EDITABLE_KEYS_PIZHAMNIK: { key: string; label: string }[] = [
  { key: 'LLM_CONTEXT', label: 'Контекст для LLM' },
  { key: 'DATES', label: 'Даты заезда/выезда' },
  { key: 'NEXT_SHIFT_TEXT', label: 'Ближайшая смена (даты)' },
  { key: 'START_MESSAGE', label: 'Приветствие /start' },
  { key: 'PROGRAM_TEXT', label: 'Текст: программа (если нет фото)' },
  { key: 'PROGRAM_PHOTO_1', label: 'URL фото программы 1' },
  { key: 'PROGRAM_PHOTO_2', label: 'URL фото программы 2' },
  { key: 'PROGRAM_PHOTO_3', label: 'URL фото программы 3' },
  { key: 'CONDITIONS_TEXT', label: 'Текст: условия и стоимость' },
  { key: 'PRICE', label: 'Цена (₽)' },
  { key: 'DEPOSIT', label: 'Задаток (₽)' },
  { key: 'REMAINDER', label: 'Остаток (₽)' },
  { key: 'PLACES_LIMIT', label: 'Лимит мест' },
  { key: 'PAYMENT_SBER', label: 'Реквизиты' },
  { key: 'DEFAULT_SHIFT', label: 'Смена по умолчанию' },
  { key: 'AVAILABLE_SHIFTS', label: 'Список смен' },
  { key: 'AFTER_PAYMENT_INSTRUCTION', label: 'Инструкция после оплаты' },
  { key: 'AFTER_RECEIPT_MESSAGE', label: 'Сообщение после чека' },
  { key: 'REFUND_DEADLINE_TEXT', label: 'Текст про возврат' },
  { key: 'REMAINDER_REMINDER_TEXT', label: 'Напоминание об остатке' },
  { key: 'PLACES_FULL_MESSAGE', label: 'Места закончились' },
  { key: 'WAITLIST_CONFIRMED_MESSAGE', label: 'Запись в лист ожидания' },
  { key: 'CONSENT_PD_TEXT', label: 'Текст согласия на ПД' },
];
