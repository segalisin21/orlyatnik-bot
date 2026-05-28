/**
 * Кнопка «Узнать программу»: до 3 фото без текста (альбом) + клавиатура.
 * Ключи листа «Настройки»: PROGRAM_PHOTO_1..3 (HTTPS). Для миграции читаются и BOOKING_CONFIRM_PHOTO_1..3.
 */

import type { Api, InlineKeyboard } from 'grammy';

import { logger } from './logger.js';

const DRIVE_HOSTS = new Set(['drive.google.com', 'drive.usercontent.google.com']);

const PROGRAM_PHOTO_KEYS = ['PROGRAM_PHOTO_1', 'PROGRAM_PHOTO_2', 'PROGRAM_PHOTO_3'] as const;
const LEGACY_BOOKING_KEYS = ['BOOKING_CONFIRM_PHOTO_1', 'BOOKING_CONFIRM_PHOTO_2', 'BOOKING_CONFIRM_PHOTO_3'] as const;

/** Извлекает id файла из типичных ссылок Google Drive (не папок). */
function extractGoogleDriveFileId(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (!DRIVE_HOSTS.has(host)) return null;
  if (/\/folders\//i.test(u.pathname)) return null;
  const fromPath = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fromPath) return fromPath[1];
  const idParam = u.searchParams.get('id');
  if (idParam && /^[a-zA-Z0-9_-]+$/.test(idParam)) return idParam;
  return null;
}

/** Приводит URL к виду, который Telegram может запросить как файл картинки. */
export function normalizePhotoUrlForTelegram(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^[\s"'«]+|[\s"'»]+$/g, '');
  const id = extractGoogleDriveFileId(trimmed);
  if (id) {
    return `https://drive.google.com/thumbnail?id=${id}&sz=w2000`;
  }
  return trimmed;
}

function collectFromKeys(kb: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = kb[k];
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export function collectProgramPhotoUrls(kb: Record<string, unknown>): string[] {
  const primary = collectFromKeys(kb, PROGRAM_PHOTO_KEYS);
  if (primary.length > 0) return primary;
  return collectFromKeys(kb, LEGACY_BOOKING_KEYS);
}

/** Одно фото по HTTPS / Google Drive URL. */
export async function sendPhotoUrl(
  api: Api,
  chatId: string | number,
  rawUrl: string,
  caption?: string
): Promise<boolean> {
  const url = normalizePhotoUrlForTelegram(rawUrl);
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    await api.sendPhoto(chatId, url, caption ? { caption } : undefined);
    return true;
  } catch (e) {
    logger.warn('sendPhotoUrl failed', { error: String(e), chatId, url });
    return false;
  }
}

/** Несколько фото по порядку (инфографики условий и т.д.). */
export async function sendPhotoUrlsSequence(
  api: Api,
  chatId: string | number,
  urls: string[]
): Promise<boolean> {
  let sent = false;
  for (const raw of urls) {
    const t = raw.trim();
    if (!t) continue;
    if (await sendPhotoUrl(api, chatId, t)) sent = true;
  }
  return sent;
}

const ZWSP = '\u2060';

/** Альбом из 1–3 фото без подписей; затем невидимое сообщение только с клавиатурой (у API нельзя прикрепить клавиатуру к media group). */
export async function sendProgramPhotosOnly(
  api: Api,
  chatId: string | number,
  rawUrls: string[],
  replyMarkup: InlineKeyboard
): Promise<boolean> {
  const urls = rawUrls
    .slice(0, 3)
    .map(normalizePhotoUrlForTelegram)
    .filter((u) => /^https?:\/\//i.test(u));
  if (urls.length === 0) return false;

  try {
    if (urls.length === 1) {
      await api.sendPhoto(chatId, urls[0]);
    } else {
      await api.sendMediaGroup(chatId, urls.map((media) => ({ type: 'photo' as const, media })));
    }
    await api.sendMessage(chatId, ZWSP, { reply_markup: replyMarkup });
    return true;
  } catch (e) {
    logger.warn('sendProgramPhotosOnly failed', { error: String(e), chatId, urls });
    return false;
  }
}
