/**
 * Генерирует CSV для импорта в Google Sheets (лист «Настройки» / «Настройки Пижамник»).
 * Запуск из корня репозитория: npx ts-node scripts/export-sheet-defaults.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { kb, kbPizhamnik } from '../src/config';
import { DEFAULT_FIELD_PROMPTS } from '../src/runtime-config';
import type { FormField } from '../src/fsm';

const root = process.cwd();

function csvCell(s: string): string {
  const t = String(s);
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function writeCsv(filename: string, rows: [string, string][]) {
  const lines = rows.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`);
  const out = path.join(root, 'docs', filename);
  fs.writeFileSync(out, '\ufeff' + ['key,value', ...lines].join('\r\n'), 'utf8');
  console.log('Wrote', out);
}

const ORLYATNIK_PAYMENT_INSTRUCTION =
  'Внеси задаток по реквизитам ниже. В комментарии к переводу ничего указывать не нужно. После перевода пришли чек (скрин или PDF) в этот чат.';

function orlyatnikRows(): [string, string][] {
  const rows: [string, string][] = [
    ['REGISTRATION_CLOSED', kb.REGISTRATION_CLOSED ? 'true' : 'false'],
    ['DATES', kb.DATES],
    ['LLM_CONTEXT', (kb as { LLM_CONTEXT?: string }).LLM_CONTEXT ?? ''],
    ['NEXT_SHIFT_TEXT', kb.NEXT_SHIFT_TEXT],
    ['DEFAULT_SHIFT', kb.DEFAULT_SHIFT],
    ['AVAILABLE_SHIFTS', kb.AVAILABLE_SHIFTS],
    ['START_MESSAGE', kb.START_MESSAGE],
    ['PROGRAM_TEXT', kb.PROGRAM_TEXT],
    ['PROGRAM_COVER_PHOTO', (kb as { PROGRAM_COVER_PHOTO?: string }).PROGRAM_COVER_PHOTO ?? ''],
    ['PROGRAM_PHOTO_1', (kb as { PROGRAM_PHOTO_1?: string }).PROGRAM_PHOTO_1 ?? ''],
    ['PROGRAM_PHOTO_2', (kb as { PROGRAM_PHOTO_2?: string }).PROGRAM_PHOTO_2 ?? ''],
    ['PROGRAM_PHOTO_3', (kb as { PROGRAM_PHOTO_3?: string }).PROGRAM_PHOTO_3 ?? ''],
    ['CONDITIONS_PRICE_PHOTO', (kb as { CONDITIONS_PRICE_PHOTO?: string }).CONDITIONS_PRICE_PHOTO ?? ''],
    ['CONDITIONS_TERMS_PHOTO', (kb as { CONDITIONS_TERMS_PHOTO?: string }).CONDITIONS_TERMS_PHOTO ?? ''],
    ['CONDITIONS_TEXT', kb.CONDITIONS_TEXT],
    ['REVIEWS_BUTTON_LABEL', (kb as { REVIEWS_BUTTON_LABEL?: string }).REVIEWS_BUTTON_LABEL ?? ''],
    ['REVIEWS_INTRO_TEXT', (kb as { REVIEWS_INTRO_TEXT?: string }).REVIEWS_INTRO_TEXT ?? ''],
    ['REVIEWS_POST_URL', (kb as { REVIEWS_POST_URL?: string }).REVIEWS_POST_URL ?? ''],
    ['CONFIRMED_CELEBRATION_PHOTO', (kb as { CONFIRMED_CELEBRATION_PHOTO?: string }).CONFIRMED_CELEBRATION_PHOTO ?? ''],
    ['CONFIRMED_PHOTO_SHIFT_0_1', (kb as { CONFIRMED_PHOTO_SHIFT_0_1?: string }).CONFIRMED_PHOTO_SHIFT_0_1 ?? ''],
    ['CONFIRMED_PHOTO_SHIFT_0_2', (kb as { CONFIRMED_PHOTO_SHIFT_0_2?: string }).CONFIRMED_PHOTO_SHIFT_0_2 ?? ''],
    ['CONFIRMED_PHOTO_SHIFT_0_3', (kb as { CONFIRMED_PHOTO_SHIFT_0_3?: string }).CONFIRMED_PHOTO_SHIFT_0_3 ?? ''],
    ['CONFIRMED_PHOTO_SHIFT_1_1', (kb as { CONFIRMED_PHOTO_SHIFT_1_1?: string }).CONFIRMED_PHOTO_SHIFT_1_1 ?? ''],
    ['CONFIRMED_PHOTO_SHIFT_1_2', (kb as { CONFIRMED_PHOTO_SHIFT_1_2?: string }).CONFIRMED_PHOTO_SHIFT_1_2 ?? ''],
    ['CONFIRMED_PHOTO_SHIFT_1_3', (kb as { CONFIRMED_PHOTO_SHIFT_1_3?: string }).CONFIRMED_PHOTO_SHIFT_1_3 ?? ''],
    ['CONFIRMED_MESSAGE_TEXT', (kb as { CONFIRMED_MESSAGE_TEXT?: string }).CONFIRMED_MESSAGE_TEXT ?? ''],
    ['CONFIRMED_MESSAGE_SHIFT_0', (kb as { CONFIRMED_MESSAGE_SHIFT_0?: string }).CONFIRMED_MESSAGE_SHIFT_0 ?? ''],
    ['CONFIRMED_MESSAGE_SHIFT_1', (kb as { CONFIRMED_MESSAGE_SHIFT_1?: string }).CONFIRMED_MESSAGE_SHIFT_1 ?? ''],
    ['LOOKS_REFERENCES_URL', (kb as { LOOKS_REFERENCES_URL?: string }).LOOKS_REFERENCES_URL ?? ''],
    ['MANAGER_ELVIRA_URL', (kb as { MANAGER_ELVIRA_URL?: string }).MANAGER_ELVIRA_URL ?? ''],
    ['MANAGER_KRISTINA_URL', (kb as { MANAGER_KRISTINA_URL?: string }).MANAGER_KRISTINA_URL ?? ''],
    ['PRICE', String(kb.PRICE)],
    ['DEPOSIT', String(kb.DEPOSIT)],
    ['PAYMENT_SBER', kb.PAYMENT_SBER],
    ['PAYMENT_INSTRUCTION', ORLYATNIK_PAYMENT_INSTRUCTION],
    ['LOCATION', kb.LOCATION],
    ['WHAT_INCLUDED', kb.WHAT_INCLUDED],
    ['WHAT_TO_TAKE', kb.WHAT_TO_TAKE],
    ['OBJECTION_PRICE', kb.OBJECTION_PRICE],
    ['OBJECTION_SOLO', kb.OBJECTION_SOLO],
    ['OBJECTION_NO_ALCOHOL', kb.OBJECTION_NO_ALCOHOL],
    ['OBJECTION_NO_COMPANY', kb.OBJECTION_NO_COMPANY],
    ['MEDIA_CHANNEL', kb.MEDIA_CHANNEL],
    ['BROADCAST_TEST_CHAT_IDS', kb.BROADCAST_TEST_CHAT_IDS ?? ''],
    ['MANAGER_FOR_COMPLEX', kb.MANAGER_FOR_COMPLEX],
    ['CONSENT_PD_TEXT', kb.CONSENT_PD_TEXT],
    ['AFTER_PAYMENT_INSTRUCTION', kb.AFTER_PAYMENT_INSTRUCTION],
  ];
  for (const field of Object.keys(DEFAULT_FIELD_PROMPTS) as FormField[]) {
    rows.push([`FIELD_PROMPT_${field}`, DEFAULT_FIELD_PROMPTS[field]]);
  }
  return rows;
}

function pizhamnikRows(): [string, string][] {
  const p = kbPizhamnik as Record<string, unknown>;
  const keys = [
    'REGISTRATION_CLOSED',
    'DATES',
    'LLM_CONTEXT',
    'NEXT_SHIFT_TEXT',
    'START_MESSAGE',
    'PROGRAM_TEXT',
    'CONDITIONS_TEXT',
    'PRICE',
    'DEPOSIT',
    'REMAINDER',
    'PLACES_LIMIT',
    'PAYMENT_SBER',
    'DEFAULT_SHIFT',
    'AVAILABLE_SHIFTS',
    'AFTER_PAYMENT_INSTRUCTION',
    'AFTER_RECEIPT_MESSAGE',
    'REFUND_DEADLINE_TEXT',
    'CHECKIN_CHECKOUT',
    'LOCATION',
    'WHAT_INCLUDED',
    'WHAT_TO_TAKE',
    'OBJECTION_PRICE',
    'OBJECTION_SOLO',
    'OBJECTION_NO_ALCOHOL',
    'OBJECTION_NO_COMPANY',
    'CONSENT_PD_TEXT',
    'PAYMENT_INSTRUCTION',
    'REMAINDER_REMINDER_TEXT',
    'PLACES_FULL_MESSAGE',
    'WAITLIST_CONFIRMED_MESSAGE',
    'EVENT_DATE',
  ] as const;
  const rows: [string, string][] = keys.map((k) => [k, String(p[k] ?? '')]);
  for (const field of Object.keys(DEFAULT_FIELD_PROMPTS) as FormField[]) {
    rows.push([`FIELD_PROMPT_${field}`, DEFAULT_FIELD_PROMPTS[field]]);
  }
  return rows;
}

writeCsv('google-sheet-nastroiki-orlyatnik-defaults.csv', orlyatnikRows());
writeCsv('google-sheet-nastroiki-pizhamnik-defaults.csv', pizhamnikRows());
