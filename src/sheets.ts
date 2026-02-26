/**
 * Google Sheets client: participants + logs. Idempotent operations, retry/backoff.
 */

import * as fs from 'fs';
import { google, sheets_v4 } from 'googleapis';
import { env, kb } from './config.js';
import { logger } from './logger.js';

const PARTICIPANTS_SHEET_ORLYATNIK = 'Участники';
const PARTICIPANTS_SHEET_PIZHAMNIK = 'Пижамник';
const LOGS_SHEET = 'Логи';
const CONFIG_SHEET = 'Настройки';
const CONFIG_SHEET_PIZHAMNIK = 'Настройки Пижамник';
const ANSWERS_SHEET = 'Ответы';
const ANSWERS_MAX_ROWS = 500;
const PARTICIPANT_HEADERS = [
  'user_id', 'username', 'chat_id', 'status', 'fio', 'city', 'dob', 'companions',
  'phone', 'comment', 'shift', 'payment_proof_file_id', 'final_sent_at', 'updated_at', 'created_at', 'last_reminder_at',
  'consent_at', 'yookassa_payment_id', 'event', 'Согласие',
];
const LOG_HEADERS = ['timestamp', 'user_id', 'status', 'direction', 'message_type', 'text_preview', 'raw_json'];

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
  /** ISO date when we last sent a step-reminder (so we don't spam). */
  last_reminder_at?: string;
  /** ISO date when user gave consent for personal data processing. */
  consent_at?: string;
  /** YooKassa payment id when paying via link (to avoid duplicate payments). */
  yookassa_payment_id?: string;
  /** Event slug: 'orlyatnik' | 'pizhamnik' or '' before choice. */
  event?: string;
  rowIndex?: number;
  /** Which sheet the row is in (for updates). */
  sheetSource?: 'Участники' | 'Пижамник';
}

export interface LogEntry {
  timestamp: string;
  user_id: string;
  status: string;
  direction: 'IN' | 'OUT';
  message_type: string;
  text_preview: string;
  raw_json?: string;
}

function getAuthClient(): sheets_v4.Sheets {
  let credentials: object;
  if (env.GOOGLE_SHEETS_CREDENTIALS) {
    try {
      credentials = JSON.parse(env.GOOGLE_SHEETS_CREDENTIALS) as object;
    } catch {
      throw new Error('GOOGLE_SHEETS_CREDENTIALS is invalid JSON');
    }
  } else if (env.GOOGLE_SHEETS_CREDENTIALS_PATH) {
    const raw = fs.readFileSync(env.GOOGLE_SHEETS_CREDENTIALS_PATH, 'utf8');
    credentials = JSON.parse(raw) as object;
  } else {
    throw new Error('Set GOOGLE_SHEETS_CREDENTIALS or GOOGLE_SHEETS_CREDENTIALS_PATH');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: credentials as never,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

let sheetsClient: sheets_v4.Sheets | null = null;
let sheetIdsCache: Record<string, number> | null = null;

function getSheets(): sheets_v4.Sheets {
  if (!sheetsClient) {
    sheetsClient = getAuthClient();
  }
  return sheetsClient;
}

/** Get sheet id by name (for batchUpdate delete row). */
async function getSheetIds(): Promise<Record<string, number>> {
  if (sheetIdsCache) return sheetIdsCache;
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: env.GOOGLE_SHEET_ID });
  const out: Record<string, number> = {};
  for (const sheet of meta.data.sheets ?? []) {
    const title = sheet.properties?.title;
    if (title != null && sheet.properties?.sheetId != null) {
      out[title] = sheet.properties.sheetId;
    }
  }
  sheetIdsCache = out;
  return out;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < MAX_RETRIES - 1) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, i);
        logger.warn('Sheets API retry', { attempt: i + 1, delayMs: delay, error: String(e) });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

type SheetSource = 'Участники' | 'Пижамник';

function rowToParticipant(row: string[], rowIndex: number, sheetSource?: SheetSource): Participant {
  const p: Participant = {
    user_id: row[0] ?? '',
    username: row[1] ?? '',
    chat_id: row[2] ?? '',
    status: row[3] ?? 'NEW',
    fio: row[4] ?? '',
    city: row[5] ?? '',
    dob: row[6] ?? '',
    companions: row[7] ?? '',
    phone: row[8] ?? '',
    comment: row[9] ?? '',
    shift: row[10] ?? '',
    payment_proof_file_id: row[11] ?? '',
    final_sent_at: row[12] ?? '',
    updated_at: row[13] ?? '',
    created_at: row[14] ?? '',
    last_reminder_at: row[15] ?? '',
    consent_at: row[16] ?? '',
    yookassa_payment_id: row[17] ?? '',
    event: row[18] ?? '',
    rowIndex: rowIndex + 2,
  };
  if (sheetSource) p.sheetSource = sheetSource;
  return p;
}

function getSheetForEvent(event: string): SheetSource {
  return event === 'pizhamnik' ? 'Пижамник' : 'Участники';
}

function participantToRow(p: Participant): string[] {
  return [
    p.user_id,
    p.username,
    p.chat_id,
    p.status,
    p.fio,
    p.city,
    p.dob,
    p.companions,
    p.phone,
    p.comment,
    p.shift,
    p.payment_proof_file_id,
    p.final_sent_at ?? '',
    p.updated_at ?? '',
    p.created_at ?? '',
    p.last_reminder_at ?? '',
    p.consent_at ?? '',
    p.yookassa_payment_id ?? '',
    p.event ?? '',
    (p.consent_at?.trim() ? 'Да' : ''),
  ];
}

/** Get one sheet's data; returns [] if sheet missing or range invalid. */
async function getSheetRows(sheetName: string): Promise<string[][]> {
  const sheets = getSheets();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${sheetName}'!A2:T`,
    });
    return (res.data.values ?? []) as string[][];
  } catch (e: unknown) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (msg.includes('Unable to parse range') || msg.includes('not found') || msg.includes('404')) {
      return [];
    }
    throw e;
  }
}

/** Get participant by user_id only. Searches Участники then Пижамник. Returns null if not found. */
export async function getParticipantByUserId(userId: number): Promise<Participant | null> {
  const uid = String(userId);
  return withRetry(async () => {
    for (const sheetName of [PARTICIPANTS_SHEET_ORLYATNIK, PARTICIPANTS_SHEET_PIZHAMNIK] as const) {
      const rows = await getSheetRows(sheetName);
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] === uid) {
          return rowToParticipant(rows[i], i, sheetName);
        }
      }
    }
    return null;
  });
}

/** Get participant by user_id or create new row in Участники (event ''). Idempotent. */
export async function getOrCreateUser(
  userId: number,
  username: string,
  chatId: number
): Promise<Participant> {
  const uid = String(userId);
  return withRetry(async () => {
    for (const sheetName of [PARTICIPANTS_SHEET_ORLYATNIK, PARTICIPANTS_SHEET_PIZHAMNIK] as const) {
      const rows = await getSheetRows(sheetName);
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] === uid) {
          return rowToParticipant(rows[i], i, sheetName);
        }
      }
    }
    const sheets = getSheets();
    const now = new Date().toISOString();
    const newRow: Participant = {
      user_id: uid,
      username: username || '',
      chat_id: String(chatId),
      status: 'NEW',
      fio: '',
      city: '',
      dob: '',
      companions: '',
      phone: '',
      comment: '',
      shift: kb.DEFAULT_SHIFT,
      payment_proof_file_id: '',
      final_sent_at: '',
      updated_at: now,
      created_at: now,
      last_reminder_at: '',
      consent_at: '',
      yookassa_payment_id: '',
      event: '',
      sheetSource: PARTICIPANTS_SHEET_ORLYATNIK,
    };
    await sheets.spreadsheets.values.append({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${PARTICIPANTS_SHEET_ORLYATNIK}'!A:T`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [participantToRow(newRow)] },
    });
    return newRow;
  });
}

/**
 * Update participant fields by user_id.
 * When event changes to pizhamnik, moves row from Участники to Пижамник.
 * Reverse move (Пижамник → Участники) is not implemented: changing event to orlyatnik only updates the row in place on the current sheet.
 */
export async function updateUserFields(
  userId: number,
  patch: Partial<Omit<Participant, 'user_id' | 'rowIndex'>>
): Promise<Participant> {
  const uid = String(userId);
  return withRetry(async () => {
    const current = await getParticipantByUserId(userId);
    if (!current) throw new Error(`Participant not found: ${uid}`);
    const sheetSource = current.sheetSource ?? PARTICIPANTS_SHEET_ORLYATNIK;
    const updated: Participant = {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    };

    if (patch.event === 'pizhamnik' && sheetSource === PARTICIPANTS_SHEET_ORLYATNIK) {
      const sheets = getSheets();
      const rows = await getSheetRows(PARTICIPANTS_SHEET_ORLYATNIK);
      const rowIndex = rows.findIndex((r) => r[0] === uid);
      if (rowIndex < 0) throw new Error(`Participant not found in Участники: ${uid}`);
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: env.GOOGLE_SHEET_ID,
          range: `'${PARTICIPANTS_SHEET_PIZHAMNIK}'!A:T`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [participantToRow({ ...updated, event: 'pizhamnik' })] },
        });
        try {
          const ids = await getSheetIds();
          const sheetId = ids[PARTICIPANTS_SHEET_ORLYATNIK];
          if (sheetId != null) {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId: env.GOOGLE_SHEET_ID,
              requestBody: {
                requests: [
                  {
                    deleteDimension: {
                      range: {
                        sheetId,
                        dimension: 'ROWS',
                        startIndex: rowIndex + 1,
                        endIndex: rowIndex + 2,
                      },
                    },
                  },
                ],
              },
            });
          }
        } catch (deleteErr) {
          logger.error('Sheet move: append succeeded but delete failed — clearing old row to prevent duplicate', { userId: uid, error: String(deleteErr) });
          const clearRange = `'${PARTICIPANTS_SHEET_ORLYATNIK}'!A${rowIndex + 2}:T${rowIndex + 2}`;
          await sheets.spreadsheets.values.update({
            spreadsheetId: env.GOOGLE_SHEET_ID,
            range: clearRange,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [participantToRow({ ...updated, event: 'pizhamnik', status: 'MOVED' } as Participant)] },
          }).catch((e) => logger.error('Failed to mark old row as MOVED', { userId: uid, error: String(e) }));
        }
        sheetIdsCache = null;
        return { ...updated, event: 'pizhamnik', sheetSource: PARTICIPANTS_SHEET_PIZHAMNIK };
      } catch (moveErr: unknown) {
        const msg = String((moveErr as { message?: string })?.message ?? moveErr);
        if (msg.includes('Unable to parse range') || msg.includes('not found') || msg.includes('404')) {
          logger.warn('Sheet Пижамник missing or invalid, keeping participant in Участники with event pizhamnik', { userId: uid });
          const range = `'${PARTICIPANTS_SHEET_ORLYATNIK}'!A${rowIndex + 2}:T${rowIndex + 2}`;
          await sheets.spreadsheets.values.update({
            spreadsheetId: env.GOOGLE_SHEET_ID,
            range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [participantToRow({ ...updated, event: 'pizhamnik' })] },
          });
          return { ...updated, event: 'pizhamnik', sheetSource: PARTICIPANTS_SHEET_ORLYATNIK };
        }
        throw moveErr;
      }
    }

    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${sheetSource}'!A2:T`,
    });
    const rows = (res.data.values ?? []) as string[][];
    const rowIndex = rows.findIndex((r) => r[0] === uid);
    if (rowIndex < 0) throw new Error(`Participant not found: ${uid}`);
    const range = `'${sheetSource}'!A${rowIndex + 2}:T${rowIndex + 2}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [participantToRow(updated)] },
    });
    return { ...updated, sheetSource };
  });
}

/** Append one log entry. */
export async function appendLog(entry: LogEntry): Promise<void> {
  await withRetry(async () => {
    const sheets = getSheets();
    const row = [
      entry.timestamp,
      entry.user_id,
      entry.status,
      entry.direction,
      entry.message_type,
      (entry.text_preview ?? '').slice(0, 500),
      entry.raw_json ?? '',
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${LOGS_SHEET}'!A:G`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  });
}

/** Get all participants with status CONFIRMED and empty final_sent_at (for cron). From both sheets. */
export async function getParticipantsPendingFinalSend(): Promise<Participant[]> {
  return withRetry(async () => {
    const sheets = getSheets();
    const out: Participant[] = [];
    for (const sheetName of [PARTICIPANTS_SHEET_ORLYATNIK, PARTICIPANTS_SHEET_PIZHAMNIK] as const) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `'${sheetName}'!A2:T`,
      });
      const rows = (res.data.values ?? []) as string[][];
      for (let i = 0; i < rows.length; i++) {
        const p = rowToParticipant(rows[i], i, sheetName);
        if (p.status === 'CONFIRMED' && !(p.final_sent_at && p.final_sent_at.trim())) {
          out.push(p);
        }
      }
    }
    return out;
  });
}

/** Get participants for broadcast from both sheets. statusFilter: 'all' | 'CONFIRMED' | 'waiting'. */
export async function getParticipantsForBroadcast(statusFilter: 'all' | 'CONFIRMED' | 'waiting'): Promise<Participant[]> {
  return withRetry(async () => {
    const sheets = getSheets();
    const out: Participant[] = [];
    const allowedStatuses =
      statusFilter === 'all'
        ? null
        : statusFilter === 'CONFIRMED'
          ? ['CONFIRMED']
          : ['WAIT_PAYMENT', 'PAYMENT_SENT'];
    for (const sheetName of [PARTICIPANTS_SHEET_ORLYATNIK, PARTICIPANTS_SHEET_PIZHAMNIK] as const) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `'${sheetName}'!A2:T`,
      });
      const rows = (res.data.values ?? []) as string[][];
      for (let i = 0; i < rows.length; i++) {
        const p = rowToParticipant(rows[i], i, sheetName);
        if (!p.chat_id || !p.chat_id.trim()) continue;
        if (allowedStatuses === null || allowedStatuses.includes(p.status)) {
          out.push(p);
        }
      }
    }
    return out;
  });
}

const OCCUPIED_STATUSES = new Set(['FORM_CONFIRM', 'WAIT_PAYMENT', 'PAYMENT_SENT', 'CONFIRMED']);

/** Count participants occupying a slot (FORM_CONFIRM..CONFIRMED) for places limit. Reads only the event's sheet. */
export async function getConfirmedCount(event: string): Promise<number> {
  return withRetry(async () => {
    const sheetName = getSheetForEvent(event);
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${sheetName}'!A2:T`,
    });
    const rows = (res.data.values ?? []) as string[][];
    let count = 0;
    for (let i = 0; i < rows.length; i++) {
      const p = rowToParticipant(rows[i], i, sheetName);
      if (OCCUPIED_STATUSES.has(p.status)) count++;
    }
    return count;
  });
}

const REMINDER_STATUSES = ['NEW', 'INFO', 'FORM_FILLING', 'FORM_CONFIRM', 'WAIT_PAYMENT', 'PAYMENT_SENT'] as const;

/** Participants who went inactive (from both sheets). */
export async function getParticipantsForReminders(
  inactiveMs: number,
  cooldownMs: number
): Promise<Participant[]> {
  return withRetry(async () => {
    const sheets = getSheets();
    const now = Date.now();
    const out: Participant[] = [];
    for (const sheetName of [PARTICIPANTS_SHEET_ORLYATNIK, PARTICIPANTS_SHEET_PIZHAMNIK] as const) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `'${sheetName}'!A2:T`,
      });
      const rows = (res.data.values ?? []) as string[][];
      for (let i = 0; i < rows.length; i++) {
        const p = rowToParticipant(rows[i], i, sheetName);
        if (!p.chat_id?.trim() || !REMINDER_STATUSES.includes(p.status as (typeof REMINDER_STATUSES)[number])) continue;
        const updatedAt = p.updated_at ? new Date(p.updated_at).getTime() : 0;
        if (now - updatedAt < inactiveMs) continue;
        const lastReminder = p.last_reminder_at ? new Date(p.last_reminder_at).getTime() : 0;
        if (lastReminder > 0 && now - lastReminder < cooldownMs) continue;
        out.push(p);
      }
    }
    return out;
  });
}

/** Pizhamnik: participants with WAIT_PAYMENT or PAYMENT_SENT for "10 days before" balance reminder. Reads only sheet Пижамник. */
export async function getParticipantsForPizhamnikReminder(): Promise<Participant[]> {
  return withRetry(async () => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${PARTICIPANTS_SHEET_PIZHAMNIK}'!A2:T`,
    });
    const rows = (res.data.values ?? []) as string[][];
    const out: Participant[] = [];
    for (let i = 0; i < rows.length; i++) {
      const p = rowToParticipant(rows[i], i, PARTICIPANTS_SHEET_PIZHAMNIK);
      if (!p.chat_id?.trim()) continue;
      if (p.status !== 'WAIT_PAYMENT' && p.status !== 'PAYMENT_SENT') continue;
      out.push(p);
    }
    return out;
  });
}

/** Config sheet name by event. Default = Орлятник (Настройки). */
function getConfigSheetName(event?: string): string {
  return event === 'pizhamnik' ? CONFIG_SHEET_PIZHAMNIK : CONFIG_SHEET;
}

/** Read key-value config from sheet. Columns A=key, B=value. Returns {} if sheet missing or empty. */
export async function getConfigFromSheet(event?: string): Promise<Record<string, string>> {
  const sheetName = getConfigSheetName(event);
  return withRetry(async () => {
    const sheets = getSheets();
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `'${sheetName}'!A2:B`,
      });
      const rows = (res.data.values ?? []) as string[][];
      const out: Record<string, string> = {};
      for (const row of rows) {
        const k = (row[0] ?? '').trim();
        if (k) out[k] = (row[1] ?? '').trim();
      }
      return out;
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (msg.includes('Unable to parse range') || msg.includes('404') || msg.includes('not found')) {
        return {};
      }
      throw e;
    }
  });
}

/** Write one config key to sheet. Updates existing row or appends. event = 'pizhamnik' uses sheet "Настройки Пижамник". */
export async function setConfigInSheet(key: string, value: string, event?: string): Promise<void> {
  const sheetName = getConfigSheetName(event);
  return withRetry(async () => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${sheetName}'!A2:B`,
    });
    const rows = (res.data.values ?? []) as string[][];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][0] ?? '').trim() === key) {
        rowIndex = i + 2;
        break;
      }
    }
    if (rowIndex >= 2) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `'${sheetName}'!B${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[value]] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `'${sheetName}'!A:B`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[key, value]] },
      });
    }
  });
}

/** Normalize question for storage lookup: lowercase, trim, collapse spaces. */
export function normalizeQuestion(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Ensure "Ответы" sheet exists; create with headers if missing. Returns sheet id for delete ops. */
async function ensureAnswersSheet(): Promise<number> {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    fields: 'sheets(properties(sheetId,title))',
  });
  const tab = meta.data.sheets?.find((s) => (s.properties?.title ?? '') === ANSWERS_SHEET);
  if (tab?.properties?.sheetId != null) {
    return tab.properties.sheetId;
  }
  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: ANSWERS_SHEET } } }],
    },
  });
  const newSheetId = addRes.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId == null) {
    throw new Error('Failed to create Answers sheet');
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: `'${ANSWERS_SHEET}'!A1:C1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['question_normalized', 'answer', 'updated_at']] },
  });
  return newSheetId;
}

/** Find stored answer by normalized question. Exact match first; then contains (user in key or key in user). */
export async function getAnswerFromStorage(normalizedQuestion: string): Promise<string | null> {
  if (!normalizedQuestion || normalizedQuestion.length < 2) return null;
  return withRetry(async () => {
    await ensureAnswersSheet();
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${ANSWERS_SHEET}'!A2:C`,
    });
    const rows = (res.data.values ?? []) as string[][];
    for (const row of rows) {
      const key = (row[0] ?? '').trim();
      const answer = (row[1] ?? '').trim();
      if (!key || !answer) continue;
      if (key === normalizedQuestion) return answer;
    }
    for (const row of rows) {
      const key = (row[0] ?? '').trim();
      const answer = (row[1] ?? '').trim();
      if (!key || !answer) continue;
      if (normalizedQuestion.includes(key) || key.includes(normalizedQuestion)) return answer;
    }
    return null;
  });
}

/** Save or update question–answer pair; trim to last ANSWERS_MAX_ROWS. */
export async function saveAnswer(question: string, answer: string): Promise<void> {
  const normalized = normalizeQuestion(question);
  if (!normalized || !answer.trim()) return;
  const now = new Date().toISOString();
  return withRetry(async () => {
    const sheetId = await ensureAnswersSheet();
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${ANSWERS_SHEET}'!A2:C`,
    });
    const rows = (res.data.values ?? []) as string[][];
    let foundAt = -1;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][0] ?? '').trim() === normalized) {
        foundAt = i;
        break;
      }
    }
    if (foundAt >= 0) {
      const range = `'${ANSWERS_SHEET}'!B${foundAt + 2}:C${foundAt + 2}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[answer.trim(), now]] },
      });
      return;
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${ANSWERS_SHEET}'!A:C`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[normalized, answer.trim(), now]] },
    });
    const newCount = rows.length + 1;
    if (newCount > ANSWERS_MAX_ROWS) {
      const toDelete = newCount - ANSWERS_MAX_ROWS;
      for (let i = 0; i < toDelete; i++) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: env.GOOGLE_SHEET_ID,
          requestBody: {
            requests: [
              {
                deleteDimension: {
                  range: {
                    sheetId,
                    dimension: 'ROWS',
                    startIndex: 1,
                    endIndex: 2,
                  },
                },
              },
            ],
          },
        });
      }
    }
  });
}
