/**
 * State machine: status transitions and persistence (Sheets + in-memory cache).
 */

import type { Participant } from './sheets.js';
import { getOrCreateUser, getParticipantByUserId, updateUserFields } from './sheets.js';
import { logger } from './logger.js';

export const STATUS = {
  NEW: 'NEW',
  INFO: 'INFO',
  WAITLIST: 'WAITLIST',
  FORM_FILLING: 'FORM_FILLING',
  FORM_CONFIRM: 'FORM_CONFIRM',
  WAIT_PAYMENT: 'WAIT_PAYMENT',
  PAYMENT_SENT: 'PAYMENT_SENT',
  CONFIRMED: 'CONFIRMED',
} as const;

export type Status = (typeof STATUS)[keyof typeof STATUS];

const VALID_TRANSITIONS: Record<string, Status[]> = {
  [STATUS.NEW]: [STATUS.INFO, STATUS.FORM_FILLING, STATUS.WAITLIST],
  [STATUS.INFO]: [STATUS.FORM_FILLING, STATUS.WAITLIST],
  [STATUS.WAITLIST]: [STATUS.FORM_FILLING, STATUS.NEW],
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

// --- Per-user mutex: serialise writes for the same user ---
const userLocks = new Map<number, Promise<unknown>>();

function withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  userLocks.set(userId, next);
  next.finally(() => {
    if (userLocks.get(userId) === next) userLocks.delete(userId);
  });
  return next;
}

// --- In-memory cache with TTL ---
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  participant: Participant;
  ts: number;
}

const userCache = new Map<number, CacheEntry>();

function getCached(userId: number): Participant | undefined {
  const entry = userCache.get(userId);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    userCache.delete(userId);
    return undefined;
  }
  return entry.participant;
}

function setCached(userId: number, p: Participant): void {
  userCache.set(userId, { participant: p, ts: Date.now() });
}

export async function getParticipant(userId: number, username: string, chatId: number): Promise<Participant> {
  let p = getCached(userId);
  if (!p) {
    p = await getOrCreateUser(userId, username, chatId);
    setCached(userId, p);
  }
  return p;
}

export async function setParticipantStatus(
  userId: number,
  newStatus: Status,
  patch?: Partial<Omit<Participant, 'user_id' | 'rowIndex'>>
): Promise<Participant> {
  return withUserLock(userId, async () => {
    const p = getCached(userId);
    const currentStatus = p?.status ?? 'NEW';
    if (!canTransition(currentStatus, newStatus)) {
      logger.warn('FSM invalid transition ignored', { userId, from: currentStatus, to: newStatus });
      const existing = p ?? (await getParticipantByUserId(userId));
      if (existing) return existing;
      throw new Error(`Participant not found: ${userId}`);
    }
    const updated = await updateUserFields(userId, { status: newStatus, ...patch });
    setCached(userId, updated);
    return updated;
  });
}

export async function patchParticipant(
  userId: number,
  patch: Partial<Omit<Participant, 'user_id' | 'rowIndex'>>
): Promise<Participant> {
  return withUserLock(userId, async () => {
    const updated = await updateUserFields(userId, patch);
    setCached(userId, updated);
    return updated;
  });
}

export function invalidateCache(userId: number): void {
  userCache.delete(userId);
}

// --- Processed update_ids: bounded Map with TTL ---
const PROCESSED_TTL_MS = 24 * 60 * 60 * 1000;
const PROCESSED_MAX_SIZE = 10_000;
const processedUpdates = new Map<number, number>();

function cleanProcessed(): void {
  const now = Date.now();
  for (const [id, ts] of processedUpdates.entries()) {
    if (now - ts > PROCESSED_TTL_MS) processedUpdates.delete(id);
  }
  if (processedUpdates.size > PROCESSED_MAX_SIZE) {
    const sorted = [...processedUpdates.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.slice(0, processedUpdates.size - PROCESSED_MAX_SIZE);
    for (const [id] of toRemove) processedUpdates.delete(id);
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
