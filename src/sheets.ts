/**
 * Google Sheets client: participants + logs. Idempotent operations, retry/backoff.
 */

import * as fs from 'fs';
import { google, sheets_v4 } from 'googleapis';
import { env, kb } from './config.js';
import { logger } from './logger.js';

const PARTICIPANTS_SHEET = 'Участники';
const LOGS_SHEET = 'Логи';
const PARTICIPANT_HEADERS = [
  'user_id', 'username', 'chat_id', 'status', 'fio', 'city', 'dob', 'companions',
  'phone', 'comment', 'shift', 'payment_proof_file_id', 'final_sent_at', 'updated_at', 'created_at', 'last_reminder_at',
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
  rowIndex?: number;
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

function getSheets(): sheets_v4.Sheets {
  if (!sheetsClient) {
    sheetsClient = getAuthClient();
  }
  return sheetsClient;
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

function rowToParticipant(row: string[], rowIndex: number): Participant {
  return {
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
    rowIndex: rowIndex + 2,
  };
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
  ];
}

/** Get participant by user_id only. Returns null if not found. */
export async function getParticipantByUserId(userId: number): Promise<Participant | null> {
  const uid = String(userId);
  return withRetry(async () => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${PARTICIPANTS_SHEET}'!A2:P`,
    });
    const rows = (res.data.values ?? []) as string[][];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === uid) {
        return rowToParticipant(rows[i], i);
      }
    }
    return null;
  });
}

/** Get participant by user_id or create new row. Idempotent. */
export async function getOrCreateUser(
  userId: number,
  username: string,
  chatId: number
): Promise<Participant> {
  const uid = String(userId);
  return withRetry(async () => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${PARTICIPANTS_SHEET}'!A2:P`,
    });
    const rows = (res.data.values ?? []) as string[][];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === uid) {
        return rowToParticipant(rows[i], i);
      }
    }
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
    };
    await sheets.spreadsheets.values.append({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${PARTICIPANTS_SHEET}'!A:P`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [participantToRow(newRow)] },
    });
    return newRow;
  });
}

/** Update participant fields by user_id. Fetches row index then updates. */
export async function updateUserFields(
  userId: number,
  patch: Partial<Omit<Participant, 'user_id' | 'rowIndex'>>
): Promise<Participant> {
  const uid = String(userId);
  return withRetry(async () => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${PARTICIPANTS_SHEET}'!A2:P`,
    });
    const rows = (res.data.values ?? []) as string[][];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === uid) {
        rowIndex = i;
        break;
      }
    }
    if (rowIndex < 0) {
      throw new Error(`Participant not found: ${uid}`);
    }
    const current = rowToParticipant(rows[rowIndex], rowIndex);
    const updated: Participant = {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    const range = `'${PARTICIPANTS_SHEET}'!A${rowIndex + 2}:P${rowIndex + 2}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [participantToRow(updated)] },
    });
    return updated;
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

/** Get all participants with status CONFIRMED and empty final_sent_at (for cron). */
export async function getParticipantsPendingFinalSend(): Promise<Participant[]> {
  return withRetry(async () => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${PARTICIPANTS_SHEET}'!A2:P`,
    });
    const rows = (res.data.values ?? []) as string[][];
    const out: Participant[] = [];
    for (let i = 0; i < rows.length; i++) {
      const p = rowToParticipant(rows[i], i);
      if (p.status === 'CONFIRMED' && !(p.final_sent_at && p.final_sent_at.trim())) {
        out.push(p);
      }
    }
    return out;
  });
}

/** Get participants for broadcast. statusFilter: 'all' | 'CONFIRMED' | 'WAIT_PAYMENT,PAYMENT_SENT'. */
export async function getParticipantsForBroadcast(statusFilter: 'all' | 'CONFIRMED' | 'waiting'): Promise<Participant[]> {
  return withRetry(async () => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${PARTICIPANTS_SHEET}'!A2:P`,
    });
    const rows = (res.data.values ?? []) as string[][];
    const out: Participant[] = [];
    const allowedStatuses =
      statusFilter === 'all'
        ? null
        : statusFilter === 'CONFIRMED'
          ? ['CONFIRMED']
          : ['WAIT_PAYMENT', 'PAYMENT_SENT'];
    for (let i = 0; i < rows.length; i++) {
      const p = rowToParticipant(rows[i], i);
      if (!p.chat_id || !p.chat_id.trim()) continue;
      if (allowedStatuses === null || allowedStatuses.includes(p.status)) {
        out.push(p);
      }
    }
    return out;
  });
}

const REMINDER_STATUSES = ['NEW', 'INFO', 'FORM_FILLING', 'FORM_CONFIRM', 'WAIT_PAYMENT', 'PAYMENT_SENT'] as const;

/** Participants who went inactive: have chat_id, are on a step we remind for, updated_at older than inactiveMs, last reminder (if any) older than cooldownMs. */
export async function getParticipantsForReminders(
  inactiveMs: number,
  cooldownMs: number
): Promise<Participant[]> {
  return withRetry(async () => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${PARTICIPANTS_SHEET}'!A2:P`,
    });
    const rows = (res.data.values ?? []) as string[][];
    const now = Date.now();
    const out: Participant[] = [];
    for (let i = 0; i < rows.length; i++) {
      const p = rowToParticipant(rows[i], i);
      if (!p.chat_id?.trim() || !REMINDER_STATUSES.includes(p.status as (typeof REMINDER_STATUSES)[number])) continue;
      const updatedAt = p.updated_at ? new Date(p.updated_at).getTime() : 0;
      if (now - updatedAt < inactiveMs) continue;
      const lastReminder = p.last_reminder_at ? new Date(p.last_reminder_at).getTime() : 0;
      if (lastReminder > 0 && now - lastReminder < cooldownMs) continue;
      out.push(p);
    }
    return out;
  });
}

export const DEFAULT_SHIFT = '1';
