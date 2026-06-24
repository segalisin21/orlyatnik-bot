/**
 * Сообщения после подтверждения оплаты (Орлятник): фото, текст, кнопки менеджеров.
 */

import { InlineKeyboard, type Api } from 'grammy';
import { env } from './config.js';
import { getKb } from './runtime-config.js';
import { sendPhotoUrl } from './send-program-photos.js';
import { logger } from './logger.js';

export function buildSecondBookingFinalKeyboard(): InlineKeyboard {
  const kb = getKb('orlyatnik');
  const label = (kb.SECOND_BOOKING_FINAL_BTN ?? 'Ещё одна путёвка').slice(0, 60);
  return new InlineKeyboard().text(label, 'book2_o');
}

function managerElviraUrl(kb: Record<string, unknown>): string {
  const u = (kb.MANAGER_ELVIRA_URL as string | undefined)?.trim();
  if (u) return u;
  const un = (kb.MANAGER_ELVIRA_USERNAME as string | undefined)?.trim() || env.MANAGER_ELVIRA_USERNAME;
  return `https://t.me/${un.replace(/^@/, '')}`;
}

function managerKristinaUrl(kb: Record<string, unknown>): string {
  const u = (kb.MANAGER_KRISTINA_URL as string | undefined)?.trim();
  if (u) return u;
  return `https://t.me/${env.MANAGER_TG_USERNAME.replace(/^@/, '')}`;
}

export function buildPostRegistrationKeyboard(kb: Record<string, unknown>): InlineKeyboard {
  const row = new InlineKeyboard();
  const looks = (kb.LOOKS_REFERENCES_URL as string | undefined)?.trim();
  if (looks) row.url('Посмотреть идеи образов', looks).row();
  row.url('Связаться с менеджером Эльвирой', managerElviraUrl(kb)).row();
  row.url('Написать главному организатору', managerKristinaUrl(kb));
  return row;
}

/** Краткое сообщение для повторного входа в статусе CONFIRMED (без полной цепочки). */
export function getConfirmedShortMessage(event: string): string {
  const kb = getKb(event);
  if (event === 'pizhamnik' && kb.AFTER_RECEIPT_MESSAGE?.trim()) {
    return kb.AFTER_RECEIPT_MESSAGE.trim();
  }
  const elviraUser = (
    (kb as { MANAGER_ELVIRA_USERNAME?: string }).MANAGER_ELVIRA_USERNAME ?? env.MANAGER_ELVIRA_USERNAME
  ).replace(/^@/, '');
  const kristinaUser = env.MANAGER_TG_USERNAME.replace(/^@/, '');
  return (
    'Ты уже в списке участников! 🎉\n\n' +
    'Общий чат участников создадим чуть позже — ссылка прилетит сюда.\n\n' +
    `Организационные и финансовые вопросы — Эльвира @${elviraUser}\n` +
    `Главный организатор — Кристина @${kristinaUser}`
  );
}

/** Полный пост-регистрационный сценарий для Орлятника. */
export async function sendPostRegistrationFlow(
  api: Api,
  chatId: string | number,
  event: string = 'orlyatnik'
): Promise<void> {
  if (event === 'pizhamnik') {
    const kb = getKb('pizhamnik');
    const text =
      kb.AFTER_RECEIPT_MESSAGE?.trim() ||
      `Ты в списке!\n\nЧат участников: ${env.CHAT_INVITE_LINK || '—'}`;
    await api.sendMessage(chatId, text);
    return;
  }

  const kb = getKb('orlyatnik') as unknown as Record<string, unknown>;
  const celebration = (kb.CONFIRMED_CELEBRATION_PHOTO as string | undefined)?.trim();
  if (celebration) {
    const ok = await sendPhotoUrl(api, chatId, celebration);
    if (!ok) logger.warn('CONFIRMED_CELEBRATION_PHOTO failed', { chatId });
  }

  const messageText =
    (kb.CONFIRMED_MESSAGE_TEXT as string | undefined)?.trim() ||
    'Поздравляем! Регистрация на 1 смену прошла успешно! 🥂🥳 Твой задаток в размере 8 000 руб. зафиксирован. Ты официальный участник самого безумного «Шапито» этого лета!\n\n' +
      'Нас будет много — от 50 до 120 самых заряженных людей на одной волне. Общий чат участников мы создадим чуть позже, ссылка прилетит сюда.';
  await api.sendMessage(chatId, messageText);

  const contactsKb = buildPostRegistrationKeyboard(kb);
  const bookLabel = ((kb.SECOND_BOOKING_FINAL_BTN as string | undefined) ?? 'Ещё одна путёвка').slice(0, 60);
  contactsKb.row().text(bookLabel, 'book2_o');

  await api.sendMessage(chatId, 'Если есть вопросы — пиши менеджерам 👇', { reply_markup: contactsKb });
}
