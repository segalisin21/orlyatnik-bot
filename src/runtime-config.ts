/**
 * Runtime config: merged defaults (config.kb) + Google Sheet "Настройки".
 * Admin can edit values via bot; no code deploy needed.
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

/** Load config from Google Sheet "Настройки". Call at startup. */
export async function loadSheetConfig(): Promise<void> {
  try {
    sheetCache = await getConfigFromSheet();
  } catch {
    sheetCache = {};
  }
}

/** Get merged config: sheet overrides defaults. */
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

  return {
    ...base,
    field_prompts: fieldPrompts,
  } as RuntimeKb;
}

/** Save one key to sheet and refresh cache. */
export async function updateConfigKey(key: string, value: string): Promise<void> {
  await setConfigInSheet(key, value);
  sheetCache[key] = value;
}

/** Keys admins can edit from the menu, with short labels. */
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
