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

/** In-memory cache: user_id -> Participant. Refreshed from Sheets on first access. */
const userCache = new Map<number, Participant>();

export async function getParticipant(userId: number, username: string, chatId: number): Promise<Participant> {
  let p = userCache.get(userId);
  if (!p) {
    p = await getOrCreateUser(userId, username, chatId);
    userCache.set(userId, p);
  }
  return p;
}

/** Update participant in Sheets and cache. Idempotent. */
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

/** Update only fields (no status change). Refreshes cache. */
export async function patchParticipant(
  userId: number,
  patch: Partial<Omit<Participant, 'user_id' | 'rowIndex'>>
): Promise<Participant> {
  const updated = await updateUserFields(userId, patch);
  userCache.set(userId, updated);
  return updated;
}

/** Invalidate cache for user (e.g. after external sheet edit). */
export function invalidateCache(userId: number): void {
  userCache.delete(userId);
}

/** Processed update_ids: in-memory LRU-style, TTL 24h. */
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

/** Required form fields and whether they are filled. */
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
