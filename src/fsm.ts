/**
 * State machine: status transitions and persistence (Sheets + in-memory cache).
 */

import type { Participant, SecondBookingScope } from './sheets.js';
import {
  getOrCreateUser,
  getParticipantByUserId,
  getAllParticipantsByUserId,
  resolvePrimaryParticipant,
  updateUserFields,
  updateParticipantRow,
  appendLog,
  appendSecondOrlyatnikBookingRow,
  computeNextBookingRef,
} from './sheets.js';
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

/**
 * Новая бронь тем же Telegram на Орлятнике: новая строка в «Участники», прошлая CONFIRMED не трогаем.
 * `scope`: `self` — копия анкеты и сразу проверка; `other` — новая анкета после согласия.
 * Если уже есть незавершённая бронь — `null`. Только orlyatnik, не лист «Пижамник».
 */
export async function startSecondOrlyatnikBooking(
  userId: number,
  scope: SecondBookingScope
): Promise<Participant | null> {
  return withUserLock(userId, async () => {
    const all = await getAllParticipantsByUserId(userId);
    const primary = resolvePrimaryParticipant(all);
    if (primary && primary.status !== STATUS.CONFIRMED) {
      return null;
    }
    const confirmedOrl = all.filter(
      (p) =>
        p.status === STATUS.CONFIRMED &&
        (p.event ?? '') === 'orlyatnik' &&
        (p.sheetSource ?? '') !== 'Пижамник'
    );
    if (confirmedOrl.length === 0) {
      return null;
    }
    confirmedOrl.sort((a, b) => (a.rowIndex ?? 0) - (b.rowIndex ?? 0));
    const source = confirmedOrl[confirmedOrl.length - 1]!;
    const booking_ref = await computeNextBookingRef(userId);
    const preview = `second_booking_append scope=${scope} ref=${booking_ref} shift=${(source.shift ?? '').slice(0, 60)} row=${String(source.rowIndex)}`;
    appendLog({
      timestamp: new Date().toISOString(),
      user_id: String(userId),
      status: STATUS.INFO,
      direction: 'OUT',
      message_type: 'second_booking_append',
      text_preview: preview.slice(0, 500),
    }).catch(() => {});

    let updated = await appendSecondOrlyatnikBookingRow(source, { scope, booking_ref });
    setCached(userId, updated);

    if (scope === 'self') {
      updated = await updateParticipantRow(updated, {
        status: STATUS.FORM_CONFIRM,
        fio: source.fio,
        city: source.city,
        dob: source.dob,
        companions: source.companions,
        phone: source.phone,
        comment: source.comment ?? '',
        shift: '',
        payment_proof_file_id: '',
        yookassa_payment_id: '',
        final_sent_at: '',
      });
      setCached(userId, updated);
    }

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

export const FORM_FIELDS = ['fio', 'city', 'dob', 'companions', 'phone', 'comment', 'shift'] as const;
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
  const eventLabel = (p.event ?? '') === 'pizhamnik' ? 'Пижамник' : 'Орлятник 21+';
  const lines = [
    `Мероприятие: ${eventLabel}`,
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
