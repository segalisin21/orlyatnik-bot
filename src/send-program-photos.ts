/**
 * Кнопка «Узнать программу»: до 3 фото без текста (альбом) + клавиатура.
 * Ключи листа «Настройки»: PROGRAM_PHOTO_1..3 (HTTPS). Для миграции читаются и BOOKING_CONFIRM_PHOTO_1..3.
 */

import { InputFile, type Api, type InlineKeyboard } from 'grammy';

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
    return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  return trimmed;
}

function isGoogleDriveUrl(raw: string): boolean {
  return extractGoogleDriveFileId(raw) !== null;
}

async function downloadPhoto(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 16) return null;
    const head = buf.subarray(0, 64).toString('utf8').toLowerCase();
    if (head.includes('<!doctype') || head.includes('<html')) return null;
    return buf;
  } catch (e) {
    logger.warn('downloadPhoto failed', { error: String(e), url });
    return null;
  }
}

/** Для Google Drive скачиваем файл и отдаём InputFile — Telegram не всегда может забрать Drive по URL. */
async function resolvePhotoMedia(raw: string): Promise<string | InputFile | null> {
  const url = normalizePhotoUrlForTelegram(raw);
  if (!/^https?:\/\//i.test(url)) return null;

  if (isGoogleDriveUrl(raw)) {
    const buf = await downloadPhoto(url);
    if (!buf) return null;
    return new InputFile(buf, 'photo.jpg');
  }

  return url;
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
  const media = await resolvePhotoMedia(rawUrl);
  if (!media) return false;

  const opts = caption ? { caption } : undefined;
  try {
    await api.sendPhoto(chatId, media, opts);
    return true;
  } catch (e) {
    if (typeof media === 'string') {
      const buf = await downloadPhoto(media);
      if (buf) {
        try {
          await api.sendPhoto(chatId, new InputFile(buf, 'photo.jpg'), opts);
          return true;
        } catch (e2) {
          logger.warn('sendPhotoUrl buffer fallback failed', { error: String(e2), chatId, url: media });
        }
      }
    }
    logger.warn('sendPhotoUrl failed', { error: String(e), chatId, url: typeof media === 'string' ? media : rawUrl });
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
  const mediaList = (
    await Promise.all(rawUrls.slice(0, 3).map((raw) => resolvePhotoMedia(raw)))
  ).filter((m): m is string | InputFile => m !== null);
  if (mediaList.length === 0) return false;

  try {
    if (mediaList.length === 1) {
      await api.sendPhoto(chatId, mediaList[0]);
    } else {
      await api.sendMediaGroup(
        chatId,
        mediaList.map((media) => ({ type: 'photo' as const, media }))
      );
    }
    await api.sendMessage(chatId, ZWSP, { reply_markup: replyMarkup });
    return true;
  } catch (e) {
    logger.warn('sendProgramPhotosOnly failed', { error: String(e), chatId, count: mediaList.length });
    return false;
  }
}
