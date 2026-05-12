/**
 * Финальное сообщение после подтверждения брони менеджером: текст + до 3 фото (альбом).
 * URL задаются в листе «Настройки»: BOOKING_CONFIRM_PHOTO_1..3 (HTTPS).
 *
 * Ссылки «Поделиться» с Google Drive (`/file/d/…/view`) отдают HTML — Telegram не скачивает из них фото.
 * {@link normalizeBookingPhotoUrl} переписывает их на URL превью (`thumbnail`), который Telegram чаще успешно скачивает. Файл в Drive: доступ «Все, у кого есть ссылка» (читатель).
 */

import type { Api } from 'grammy';

import { logger } from './logger.js';

const TG_CAPTION_MAX = 1024;

const PHOTO_KEYS = ['BOOKING_CONFIRM_PHOTO_1', 'BOOKING_CONFIRM_PHOTO_2', 'BOOKING_CONFIRM_PHOTO_3'] as const;

const DRIVE_HOSTS = new Set(['drive.google.com', 'drive.usercontent.google.com']);

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

/**
 * Приводит URL к виду, который Telegram может запросить как файл картинки.
 * Google Drive «view» / «open» → ссылка на превью (image/jpeg), пригодная для sendPhoto.
 */
export function normalizeBookingPhotoUrl(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^[\s"'«]+|[\s"'»]+$/g, '');
  const id = extractGoogleDriveFileId(trimmed);
  if (id) {
    return `https://drive.google.com/thumbnail?id=${id}&sz=w2000`;
  }
  return trimmed;
}

export function collectBookingConfirmPhotoUrls(kb: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of PHOTO_KEYS) {
    const v = kb[k];
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Текст + опционально до 3 снимков одним альбомом (если все URL заданы в настройках). */
export async function sendBookingConfirmedWithPhotos(
  api: Api,
  chatId: string,
  text: string,
  photoUrls: string[]
): Promise<void> {
  const urls = photoUrls
    .slice(0, 3)
    .map(normalizeBookingPhotoUrl)
    .filter((u) => /^https?:\/\//i.test(u));
  if (urls.length === 0) {
    await api.sendMessage(chatId, text);
    return;
  }

  const captionOk = text.length <= TG_CAPTION_MAX;
  let sentText = false;

  try {
    if (urls.length === 1) {
      if (captionOk) {
        await api.sendPhoto(chatId, urls[0], { caption: text });
      } else {
        await api.sendMessage(chatId, text);
        sentText = true;
        await api.sendPhoto(chatId, urls[0]);
      }
      return;
    }

    if (captionOk) {
      await api.sendMediaGroup(chatId, [
        { type: 'photo', media: urls[0], caption: text },
        ...urls.slice(1).map((media) => ({ type: 'photo' as const, media })),
      ]);
    } else {
      await api.sendMessage(chatId, text);
      sentText = true;
      await api.sendMediaGroup(chatId, urls.map((media) => ({ type: 'photo' as const, media })));
    }
  } catch (e) {
    logger.warn('sendBookingConfirmedWithPhotos: media failed', {
      error: String(e),
      chatId,
      urls,
    });
    if (!sentText) {
      try {
        await api.sendMessage(chatId, text);
      } catch (e2) {
        logger.error('sendBookingConfirmedWithPhotos: text fallback failed', { error: String(e2), chatId });
      }
    }
  }
}
