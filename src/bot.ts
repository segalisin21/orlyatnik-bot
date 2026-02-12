/**
 * Telegram bot: handlers for text, voice, photo, document. FSM-driven, LLM, Sheets.
 */

import { Bot } from 'grammy';
import { env, kb } from './config.js';
import { logger } from './logger.js';
import {
  getParticipant,
  setParticipantStatus,
  patchParticipant,
  isFormComplete,
  getNextEmptyField,
  formatAnketa,
  isUpdateProcessed,
  markUpdateProcessed,
  STATUS,
  type FormField,
} from './fsm.js';
import { getSalesReply, getFormModeReply } from './llm.js';
import { transcribeVoice } from './voice.js';
import { appendLog } from './sheets.js';
import type { Participant } from './sheets.js';

const FIELD_PROMPTS: Record<FormField, string> = {
  fio: 'Напиши, пожалуйста, ФИО (как в паспорте).',
  city: 'Из какого ты города?',
  dob: 'Дата рождения? (можно в любом формате)',
  companions: 'С кем едешь? (один/одна, вдвоём, думаешь — напиши как есть)',
  phone: 'Номер телефона для связи?',
  shift: 'Какая смена? (если не знаешь — напиши «по умолчанию»)',
};

/** Фразы, по которым переключается статус. Бот должен явно их подсказывать. */
const PHRASE_BOOK = /(хочу|готов|давай)\s*(забронировать|записаться|участвовать|ехать)|бронирую|записываюсь|записывай|готов\s*забронировать|готов\s*записаться/i;
const PHRASE_CONFIRM_ANKETA = /^(да|подтверждаю|ок|окей|всё верно|все верно|верно|готово|да,?\s*верно|подтверждаю анкету)$/i;
const PHRASE_HINT_BOOK = '👉 Чтобы начать заполнение анкеты, напиши: «Хочу забронировать» или «Готов забронировать»';
const PHRASE_HINT_CONFIRM = '👉 Чтобы перейти к оплате, напиши: «Да» или «Подтверждаю»';
const PHRASE_HINT_RECEIPT = '👉 Чтобы подтвердить оплату, пришли чек (фото или документ) сюда в бота';

function normalizePhone(s: string): string {
  return s.replace(/[^\d+]/g, '');
}

export function createBot(): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  async function logOut(userId: string, status: string, direction: 'IN' | 'OUT', messageType: string, textPreview: string, raw?: string) {
    try {
      await appendLog({
        timestamp: new Date().toISOString(),
        user_id: userId,
        status,
        direction,
        message_type: messageType,
        text_preview: textPreview,
        raw_json: raw,
      });
    } catch {
      // non-fatal
    }
  }

  async function sendToAdmin(text: string, extra?: { caption?: string; photo?: string; document?: string }) {
    if (!env.ADMIN_CHAT_ID) return;
    try {
      if (extra?.photo) {
        await bot.api.sendPhoto(env.ADMIN_CHAT_ID, extra.photo, { caption: text });
      } else if (extra?.document) {
        await bot.api.sendDocument(env.ADMIN_CHAT_ID, extra.document, { caption: text });
      } else {
        await bot.api.sendMessage(env.ADMIN_CHAT_ID, text);
      }
    } catch (e) {
      logger.error('Send to admin failed', { error: String(e) });
    }
  }

  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    if (isUpdateProcessed(updateId)) {
      return;
    }
    markUpdateProcessed(updateId);
    await next();
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const username = ctx.from?.username ?? '';
    const text = ctx.message.text?.trim() ?? '';
    if (!userId || !chatId) return;

    let p: Participant;
    try {
      p = await getParticipant(userId, username, chatId);
    } catch (e) {
      logger.error('getParticipant failed', { userId, error: String(e) });
      await ctx.reply('Что-то пошло не так. Попробуй позже или напиши @krisis_pr.');
      return;
    }
    await logOut(String(userId), p.status, 'IN', 'text', text.slice(0, 200));

    const formStatuses: string[] = [STATUS.FORM_FILLING, STATUS.FORM_CONFIRM];
    if (formStatuses.includes(p.status)) {
      if (p.status === STATUS.FORM_CONFIRM && PHRASE_CONFIRM_ANKETA.test(text)) {
        await setParticipantStatus(userId, STATUS.WAIT_PAYMENT);
        const again = formatAnketa(p);
        await ctx.reply(
          `Отлично! Реквизиты для задатка:\n\n${kb.PAYMENT_SBER}\n\nПовторяю анкету:\n${again}\n\n${kb.AFTER_PAYMENT_INSTRUCTION}\n\n${PHRASE_HINT_RECEIPT}`
        );
        return;
      }
      const out = await getFormModeReply(text, p.status, p);
      const patch = out.form_patch || {};
      if (Object.keys(patch).length > 0) {
        const updates: Partial<Participant> = {};
        if (patch.fio !== undefined) updates.fio = patch.fio.trim();
        if (patch.city !== undefined) updates.city = patch.city.trim();
        if (patch.dob !== undefined) updates.dob = patch.dob.trim();
        if (patch.companions !== undefined) updates.companions = patch.companions.trim();
        if (patch.phone !== undefined) updates.phone = normalizePhone(patch.phone);
        if (patch.comment !== undefined) updates.comment = patch.comment.trim();
        if (patch.shift !== undefined) updates.shift = patch.shift.trim() || kb.DEFAULT_SHIFT;
        if (Object.keys(updates).length > 0) {
          p = await patchParticipant(userId, updates);
        }
      }
      if (out.needs_confirmation && isFormComplete(p)) {
        await setParticipantStatus(userId, STATUS.FORM_CONFIRM);
        p = await getParticipant(userId, username, chatId);
        const fullAnketa = formatAnketa(p);
        await ctx.reply(`Проверь анкету:\n\n${fullAnketa}\n\n${PHRASE_HINT_CONFIRM}`);
        await logOut(String(userId), STATUS.FORM_CONFIRM, 'OUT', 'text', 'anketa confirm');
        return;
      }
      if (isFormComplete(p)) {
        await setParticipantStatus(userId, STATUS.FORM_CONFIRM);
        const fullAnketa = formatAnketa(p);
        await ctx.reply(out.reply_text + (out.reply_text.includes('анкет') ? '' : '\n\nТвоя анкета:\n' + fullAnketa + '\n\n' + PHRASE_HINT_CONFIRM));
      } else {
        const next = getNextEmptyField(p);
        const prompt = next ? FIELD_PROMPTS[next] : '';
        await ctx.reply(out.reply_text + (prompt ? '\n\n' + prompt : ''));
      }
      await logOut(String(userId), p.status, 'OUT', 'text', (out.reply_text || '').slice(0, 200));
      return;
    }

    if (p.status === STATUS.WAIT_PAYMENT || p.status === STATUS.PAYMENT_SENT) {
      await ctx.reply(
        `${PHRASE_HINT_RECEIPT}. Тогда смогу принять и передать менеджеру. Если уже отправил(а) — жди подтверждения.`
      );
      return;
    }

    if (p.status === STATUS.CONFIRMED) {
      await ctx.reply(`Ты уже в списке! Чат: ${env.CHAT_INVITE_LINK || '—'}. Менеджер: @${env.MANAGER_TG_USERNAME}`);
      return;
    }

    if (/оплатил|оплатила|перевёл|перевела|сделал перевод|сделала перевод/i.test(text)) {
      await ctx.reply(`${PHRASE_HINT_RECEIPT}. Тогда смогу принять и передать менеджеру.`);
      return;
    }

    if (/покажи.*анкет|анкету покажи|мою анкет|покажи мою|где анкет|уже заполнил|заполнил же/i.test(text) && (p.fio || p.city || p.phone)) {
      const fullAnketa = formatAnketa(p);
      await ctx.reply(`Вот твоя анкета:\n\n${fullAnketa}\n\n${PHRASE_HINT_CONFIRM}`);
      return;
    }

    const reply = await getSalesReply(text);
    await ctx.reply(reply);
    await logOut(String(userId), p.status, 'OUT', 'text', reply.slice(0, 200));

    if (p.status === STATUS.NEW) {
      await setParticipantStatus(userId, STATUS.INFO);
    }
    if (PHRASE_BOOK.test(text)) {
      await setParticipantStatus(userId, STATUS.FORM_FILLING);
      p = await getParticipant(userId, username, chatId);
      const next = getNextEmptyField(p);
      const prompt = next ? FIELD_PROMPTS[next] : '';
      await ctx.reply(prompt || PHRASE_HINT_CONFIRM);
    }
  });

  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const username = ctx.from?.username ?? '';
    const voice = ctx.message.voice;
    if (!userId || !chatId || !voice) return;

    let p: Participant;
    try {
      p = await getParticipant(userId, username, chatId);
    } catch (e) {
      logger.error('getParticipant failed', { userId, error: String(e) });
      await ctx.reply('Что-то пошло не так. Попробуй позже или напиши @krisis_pr.');
      return;
    }
    await logOut(String(userId), p.status, 'IN', 'voice', '[voice]');

    const fileId = voice.file_id;
    const getFile = async (fid: string) => {
      const f = await ctx.api.getFile(fid);
      const path = f.file_path;
      const href = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`;
      return { href };
    };
    const text = await transcribeVoice(fileId, getFile);
    if (!text) {
      await ctx.reply('Голос не разобрал. Напиши, пожалуйста, текстом.');
      return;
    }
    await logOut(String(userId), p.status, 'IN', 'voice_transcribed', text.slice(0, 200));

    const formStatusesVoice: string[] = [STATUS.FORM_FILLING, STATUS.FORM_CONFIRM];
    if (formStatusesVoice.includes(p.status)) {
      if (p.status === STATUS.FORM_CONFIRM && PHRASE_CONFIRM_ANKETA.test(text)) {
        await setParticipantStatus(userId, STATUS.WAIT_PAYMENT);
        const again = formatAnketa(p);
        await ctx.reply(
          `Отлично! Реквизиты для задатка:\n\n${kb.PAYMENT_SBER}\n\nПовторяю анкету:\n${again}\n\n${kb.AFTER_PAYMENT_INSTRUCTION}\n\n${PHRASE_HINT_RECEIPT}`
        );
        return;
      }
      const out = await getFormModeReply(text, p.status, p);
      const patch = out.form_patch || {};
      if (Object.keys(patch).length > 0) {
        const updates: Partial<Participant> = {};
        if (patch.fio !== undefined) updates.fio = patch.fio.trim();
        if (patch.city !== undefined) updates.city = patch.city.trim();
        if (patch.dob !== undefined) updates.dob = patch.dob.trim();
        if (patch.companions !== undefined) updates.companions = patch.companions.trim();
        if (patch.phone !== undefined) updates.phone = normalizePhone(patch.phone);
        if (patch.comment !== undefined) updates.comment = patch.comment.trim();
        if (patch.shift !== undefined) updates.shift = patch.shift.trim() || kb.DEFAULT_SHIFT;
        if (Object.keys(updates).length > 0) {
          p = await patchParticipant(userId, updates);
        }
      }
      if (out.needs_confirmation && isFormComplete(p)) {
        await setParticipantStatus(userId, STATUS.FORM_CONFIRM);
        p = await getParticipant(userId, username, chatId);
        const fullAnketa = formatAnketa(p);
        await ctx.reply(`Проверь анкету:\n\n${fullAnketa}\n\n${PHRASE_HINT_CONFIRM}`);
      } else if (isFormComplete(p)) {
        await setParticipantStatus(userId, STATUS.FORM_CONFIRM);
        const fullAnketa = formatAnketa(p);
        await ctx.reply(out.reply_text + '\n\nТвоя анкета:\n' + fullAnketa + '\n\n' + PHRASE_HINT_CONFIRM);
      } else {
        const next = getNextEmptyField(p);
        await ctx.reply(out.reply_text + (next ? '\n\n' + FIELD_PROMPTS[next] : ''));
      }
      return;
    }

    if (p.status === STATUS.WAIT_PAYMENT || p.status === STATUS.PAYMENT_SENT) {
      await ctx.reply(`${PHRASE_HINT_RECEIPT}. Тогда смогу принять и передать менеджеру.`);
      return;
    }

    if (p.status === STATUS.CONFIRMED) {
      await ctx.reply(`Ты уже в списке! Чат: ${env.CHAT_INVITE_LINK || '—'}. Менеджер: @${env.MANAGER_TG_USERNAME}`);
      return;
    }

    if (/оплатил|оплатила|перевёл|перевела|сделал перевод|сделала перевод/i.test(text)) {
      await ctx.reply(`${PHRASE_HINT_RECEIPT}. Тогда смогу принять и передать менеджеру.`);
      return;
    }

    if (/покажи.*анкет|анкету покажи|мою анкет|покажи мою|где анкет|уже заполнил|заполнил же/i.test(text) && (p.fio || p.city || p.phone)) {
      const fullAnketa = formatAnketa(p);
      await ctx.reply(`Вот твоя анкета:\n\n${fullAnketa}\n\n${PHRASE_HINT_CONFIRM}`);
      return;
    }

    const reply = await getSalesReply(text);
    await ctx.reply(reply);
    await logOut(String(userId), p.status, 'OUT', 'text', reply.slice(0, 200));

    if (p.status === STATUS.NEW) {
      await setParticipantStatus(userId, STATUS.INFO);
    }
    if (PHRASE_BOOK.test(text)) {
      await setParticipantStatus(userId, STATUS.FORM_FILLING);
      p = await getParticipant(userId, username, chatId);
      const next = getNextEmptyField(p);
      await ctx.reply(next ? FIELD_PROMPTS[next] : PHRASE_HINT_CONFIRM);
    }
  });

  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const username = ctx.from?.username ?? '';
    const photo = ctx.message.photo;
    if (!userId || !chatId || !photo?.length) return;

    let p: Participant;
    try {
      p = await getParticipant(userId, username, chatId);
    } catch (e) {
      logger.error('getParticipant failed', { userId, error: String(e) });
      await ctx.reply('Что-то пошло не так. Попробуй позже или напиши @krisis_pr.');
      return;
    }
    const fileId = photo[photo.length - 1].file_id;
    await logOut(String(userId), p.status, 'IN', 'photo', '[photo]');

    if (p.status !== STATUS.WAIT_PAYMENT && p.status !== STATUS.PAYMENT_SENT) {
      await ctx.reply('Фото приму как чек только после того, как заполнишь анкету и перейдёшь к оплате. Пока что напиши текстом или голосом, что хочешь узнать.');
      return;
    }

    await setParticipantStatus(userId, STATUS.PAYMENT_SENT, { payment_proof_file_id: fileId });
    const updated = await getParticipant(userId, username, chatId);
    const anketa = formatAnketa(updated);
    const adminText = `Чек (фото) от участника.\n@${username} (id: ${userId})\n\n${anketa}\n\nПодтверди оплату в таблице (статус CONFIRMED).`;
    await sendToAdmin(adminText, { photo: fileId });
    await ctx.reply('Принял, ждём подтверждения. Как только менеджер подтвердит — пришлю ссылку на чат и контакт.');
    await logOut(String(userId), STATUS.PAYMENT_SENT, 'OUT', 'text', 'payment received');
  });

  bot.on('message:document', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const username = ctx.from?.username ?? '';
    const doc = ctx.message.document;
    if (!userId || !chatId || !doc) return;

    let p: Participant;
    try {
      p = await getParticipant(userId, username, chatId);
    } catch (e) {
      logger.error('getParticipant failed', { userId, error: String(e) });
      await ctx.reply('Что-то пошло не так. Попробуй позже или напиши @krisis_pr.');
      return;
    }
    const fileId = doc.file_id;
    await logOut(String(userId), p.status, 'IN', 'document', '[document]');

    if (p.status !== STATUS.WAIT_PAYMENT && p.status !== STATUS.PAYMENT_SENT) {
      await ctx.reply('Документ приму как чек только после анкеты и перехода к оплате. Пока напиши текстом или голосом.');
      return;
    }

    await setParticipantStatus(userId, STATUS.PAYMENT_SENT, { payment_proof_file_id: fileId });
    const updated = await getParticipant(userId, username, chatId);
    const anketa = formatAnketa(updated);
    const adminText = `Чек (документ) от участника.\n@${username} (id: ${userId})\n\n${anketa}\n\nПодтверди оплату в таблице (статус CONFIRMED).`;
    await sendToAdmin(adminText, { document: fileId });
    await ctx.reply('Принял, ждём подтверждения. Как только менеджер подтвердит — пришлю ссылку на чат и контакт.');
    await logOut(String(userId), STATUS.PAYMENT_SENT, 'OUT', 'text', 'payment received');
  });

  bot.on(['message:sticker', 'message:animation', 'message:video', 'message:audio', 'message:video_note'], async (ctx) => {
    await ctx.reply('Лучше напиши текстом или голосом — так смогу помочь. Если хочешь прислать чек — отправь фото или документ после перехода к оплате.');
  });

  bot.catch((err) => {
    logger.error('Bot error', { error: err.message, stack: err.stack });
  });

  return bot;
}
