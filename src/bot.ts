/**
 * Telegram bot: handlers for text, voice, photo, document. FSM-driven, LLM, Sheets.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { env, isAdmin } from './config.js';
import { getKb, updateConfigKey, loadSheetConfig, EDITABLE_KEYS } from './runtime-config.js';
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
import { appendLog, updateUserFields, getParticipantByUserId, getParticipantsForBroadcast } from './sheets.js';
import { invalidateCache } from './fsm.js';
import type { Participant } from './sheets.js';

function getFieldPrompts(): Record<FormField, string> {
  return getKb().field_prompts;
}

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

  const adminChatIds = (): number[] =>
    env.ADMIN_CHAT_IDS.length > 0 ? env.ADMIN_CHAT_IDS : env.ADMIN_CHAT_ID ? [env.ADMIN_CHAT_ID] : [];

  async function sendToAdmin(text: string, extra?: { photo?: string; document?: string; confirmUserId?: number }) {
    const ids = adminChatIds();
    if (ids.length === 0) return;
    const keyboard = extra?.confirmUserId
      ? new InlineKeyboard().text('✅ Подтвердить оплату', `confirm_${extra.confirmUserId}`)
      : undefined;
    const replyMarkup = keyboard ? { reply_markup: keyboard } : {};
    for (const chatId of ids) {
      try {
        if (extra?.photo) {
          await bot.api.sendPhoto(chatId, extra.photo, { caption: text, ...replyMarkup });
        } else if (extra?.document) {
          await bot.api.sendDocument(chatId, extra.document, { caption: text, ...replyMarkup });
        } else {
          await bot.api.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {});
        }
      } catch (e) {
        logger.error('Send to admin failed', { error: String(e), adminChatId: chatId });
      }
    }
  }

  const adminBroadcastPending = new Map<number, { audience: 'all' | 'CONFIRMED' | 'waiting' }>();
  const adminSettingsPending = new Map<number, { key: string }>();

  function getAdminMenuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text('📢 Рассылка', 'admin_broadcast')
      .text('📊 Статистика', 'admin_stats').row()
      .text('⚙ Настройки', 'admin_settings');
  }

  function getBroadcastAudienceKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text('Всем в таблице', 'admin_br_all')
      .text('Подтверждённые', 'admin_br_confirmed').row()
      .text('Ждут оплаты / чек', 'admin_br_waiting');
  }

  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    const updateType = Object.keys(ctx.update).filter((k) => k !== 'update_id').join(', ') || 'unknown';
    logger.info('Webhook update', { updateId, updateType });
    if (isUpdateProcessed(updateId)) {
      logger.info('Update skipped (already processed)', { updateId });
      return;
    }
    markUpdateProcessed(updateId);
    await next();
  });

  bot.on('callback_query', async (ctx) => {
    let answered = false;
    const safeAnswer = async (text?: string) => {
      if (answered) return;
      try {
        await ctx.answerCallbackQuery(text ? { text } : {});
        answered = true;
      } catch (e) {
        logger.error('answerCallbackQuery failed', { error: String(e) });
      }
    };
    try {
      const data = ctx.callbackQuery.data ?? '';
      const fromId = ctx.from?.id ?? ctx.callbackQuery.from?.id;
      logger.info('Callback received', { data, fromId });
      if (fromId === undefined || !isAdmin(fromId)) {
        await safeAnswer('Только менеджер может подтверждать.');
        return;
      }
      if (data === 'admin_broadcast') {
        await safeAnswer();
        await ctx.reply('Кому отправить рассылку?', { reply_markup: getBroadcastAudienceKeyboard() });
        return;
      }
      if (data === 'admin_br_all' || data === 'admin_br_confirmed' || data === 'admin_br_waiting') {
        const audience = data === 'admin_br_all' ? 'all' : data === 'admin_br_confirmed' ? 'CONFIRMED' : 'waiting';
        adminBroadcastPending.set(fromId!, { audience });
        await safeAnswer();
        await ctx.reply(
          'Напиши текст сообщения для рассылки (одним сообщением). Отправь /cancel чтобы отменить.',
          { reply_markup: { remove_keyboard: true } }
        );
        return;
      }
      if (data === 'admin_stats') {
        await safeAnswer();
        try {
          const [all, confirmed, waiting] = await Promise.all([
            getParticipantsForBroadcast('all'),
            getParticipantsForBroadcast('CONFIRMED'),
            getParticipantsForBroadcast('waiting'),
          ]);
          await ctx.reply(
            `📊 Участники в таблице:\n\n` +
              `Всего с chat_id: ${all.length}\n` +
              `Подтверждённые: ${confirmed.length}\n` +
              `Ждут оплаты / чек: ${waiting.length}`
          );
        } catch (e) {
          logger.error('Admin stats error', { error: String(e) });
          await ctx.reply('Ошибка при запросе статистики.');
        }
        return;
      }
      if (data === 'admin_menu') {
        await safeAnswer();
        await ctx.reply('Админ-меню:', { reply_markup: getAdminMenuKeyboard() });
        return;
      }
      if (data === 'admin_settings') {
        await safeAnswer();
        const kb = getKb();
        const lines = EDITABLE_KEYS.map(({ key, label }) => {
          const raw = key.startsWith('FIELD_PROMPT_') ? (kb.field_prompts as Record<string, string>)[key.replace('FIELD_PROMPT_', '')] ?? '—' : (kb as unknown as Record<string, unknown>)[key];
          const val = typeof raw === 'string' ? (raw.slice(0, 40) + (raw.length > 40 ? '…' : '')) : String(raw ?? '—');
          return `• ${label}: ${val}`;
        });
        const keyboard = new InlineKeyboard();
        EDITABLE_KEYS.forEach(({ key, label }, i) => {
          keyboard.text(label, `admin_set_${key}`);
          if (i % 2 === 1) keyboard.row();
        });
        await ctx.reply('⚙ Настройки (из листа «Настройки» в таблице). Пустые — из кода.\n\n' + lines.join('\n'), { reply_markup: keyboard });
        return;
      }
      if (data.startsWith('admin_set_')) {
        const key = data.replace('admin_set_', '');
        const label = EDITABLE_KEYS.find((e) => e.key === key)?.label ?? key;
        adminSettingsPending.set(fromId!, { key });
        await safeAnswer();
        await ctx.reply(`Введите новое значение для «${label}» (одним сообщением). /cancel — отмена.`, { reply_markup: { remove_keyboard: true } });
        return;
      }
      if (!data.startsWith('confirm_')) {
        await safeAnswer('Неизвестная кнопка.');
        return;
      }
      const targetUserId = data.replace('confirm_', '');
      const userIdNum = Number(targetUserId);
      if (!userIdNum) {
        await safeAnswer('Неверные данные.');
        return;
      }
      const p = await getParticipantByUserId(userIdNum);
      if (!p || p.status !== STATUS.PAYMENT_SENT) {
        await safeAnswer('Уже подтверждено или участник не найден.');
        return;
      }
      const now = new Date().toISOString();
      await updateUserFields(userIdNum, { status: STATUS.CONFIRMED, final_sent_at: now });
      invalidateCache(userIdNum);
      const finalText = `Ты в списке!\n\nЧат участников: ${env.CHAT_INVITE_LINK || '—'}\nМенеджер: @${env.MANAGER_TG_USERNAME}`;
      await bot.api.sendMessage(p.chat_id, finalText);
      await safeAnswer('Оплата подтверждена');
      const msg = ctx.callbackQuery.message;
      const adminChatId = msg?.chat?.id ?? adminChatIds()[0];
      const emptyKeyboard = { reply_markup: { inline_keyboard: [] as never[] } };
      if (msg && 'caption' in msg && adminChatId) {
        await ctx.api.editMessageCaption(adminChatId, msg.message_id, {
          caption: (msg.caption || '') + '\n\n✅ Подтверждено',
          ...emptyKeyboard,
        });
      } else if (msg && 'text' in msg && adminChatId) {
        await ctx.api.editMessageText(adminChatId, msg.message_id, (msg.text || '') + '\n\n✅ Подтверждено', emptyKeyboard);
      }
      logger.info('Payment confirmed via button', { user_id: targetUserId });
    } catch (e) {
      logger.error('Confirm button error', { error: String(e), stack: (e as Error).stack });
      await safeAnswer('Ошибка, попробуй в таблице.');
    } finally {
      await safeAnswer();
    }
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const username = ctx.from?.username ?? '';
    const text = ctx.message.text?.trim() ?? '';
    if (!userId || !chatId) return;

    if (isAdmin(userId)) {
      if (text === '/cancel') {
        adminBroadcastPending.delete(userId);
        adminSettingsPending.delete(userId);
        await ctx.reply('Отменено.');
        return;
      }
      const settingsPending = adminSettingsPending.get(userId);
      if (settingsPending) {
        adminSettingsPending.delete(userId);
        try {
          await updateConfigKey(settingsPending.key, text);
          const label = EDITABLE_KEYS.find((e) => e.key === settingsPending.key)?.label ?? settingsPending.key;
          await ctx.reply(`✅ Сохранено: «${label}». Значение записано в лист «Настройки» — бот уже использует его.`);
        } catch (e) {
          logger.error('Settings save error', { error: String(e), key: settingsPending.key });
          await ctx.reply('Ошибка записи в таблицу. Проверь, что лист «Настройки» есть в таблице.');
        }
        return;
      }
      const pending = adminBroadcastPending.get(userId);
      if (pending) {
        adminBroadcastPending.delete(userId);
        try {
          const list = await getParticipantsForBroadcast(pending.audience);
          if (list.length === 0) {
            await ctx.reply('Нет получателей для выбранной категории.');
            return;
          }
          let sent = 0;
          let failed = 0;
          const delayMs = 50;
          for (const p of list) {
            try {
              await bot.api.sendMessage(p.chat_id, text);
              sent++;
              await new Promise((r) => setTimeout(r, delayMs));
            } catch (e) {
              failed++;
              logger.warn('Broadcast send failed', { chat_id: p.chat_id, user_id: p.user_id, error: String(e) });
            }
          }
          await ctx.reply(`Рассылка завершена. Отправлено: ${sent}, ошибок: ${failed}.`);
          logger.info('Admin broadcast', { audience: pending.audience, sent, failed });
        } catch (e) {
          logger.error('Broadcast error', { error: String(e) });
          await ctx.reply('Ошибка при рассылке.');
        }
        return;
      }
      if (text === '/start' || text === '/admin') {
        await ctx.reply(
          'Привет! Админ-меню. Уведомления о чеках приходят сюда — подтверждай кнопкой под сообщением.',
          { reply_markup: getAdminMenuKeyboard() }
        );
        return;
      }
    }

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
          `Отлично! Реквизиты для задатка:\n\n${getKb().PAYMENT_SBER}\n\nПовторяю анкету:\n${again}\n\n${getKb().AFTER_PAYMENT_INSTRUCTION}\n\n${PHRASE_HINT_RECEIPT}`
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
        if (patch.shift !== undefined) updates.shift = patch.shift.trim() || getKb().DEFAULT_SHIFT;
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
        const prompt = next ? getFieldPrompts()[next] : '';
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
      const prompt = next ? getFieldPrompts()[next] : '';
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
          `Отлично! Реквизиты для задатка:\n\n${getKb().PAYMENT_SBER}\n\nПовторяю анкету:\n${again}\n\n${getKb().AFTER_PAYMENT_INSTRUCTION}\n\n${PHRASE_HINT_RECEIPT}`
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
        if (patch.shift !== undefined) updates.shift = patch.shift.trim() || getKb().DEFAULT_SHIFT;
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
        await ctx.reply(out.reply_text + (next ? '\n\n' + getFieldPrompts()[next] : ''));
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
      await ctx.reply(next ? getFieldPrompts()[next] : PHRASE_HINT_CONFIRM);
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
    if (p.status === STATUS.PAYMENT_SENT) {
      await ctx.reply('Чек уже принят, ждём подтверждения от менеджера.');
      return;
    }

    await setParticipantStatus(userId, STATUS.PAYMENT_SENT, { payment_proof_file_id: fileId });
    const updated = await getParticipant(userId, username, chatId);
    const anketa = formatAnketa(updated);
    const adminText = `Чек (фото) от участника.\n@${username} (id: ${userId})\n\n${anketa}\n\nНажми кнопку ниже или измени статус в таблице на CONFIRMED.`;
    await sendToAdmin(adminText, { photo: fileId, confirmUserId: userId });
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
    if (p.status === STATUS.PAYMENT_SENT) {
      await ctx.reply('Чек уже принят, ждём подтверждения от менеджера.');
      return;
    }

    await setParticipantStatus(userId, STATUS.PAYMENT_SENT, { payment_proof_file_id: fileId });
    const updated = await getParticipant(userId, username, chatId);
    const anketa = formatAnketa(updated);
    const adminText = `Чек (документ) от участника.\n@${username} (id: ${userId})\n\n${anketa}\n\nНажми кнопку ниже или измени статус в таблице на CONFIRMED.`;
    await sendToAdmin(adminText, { document: fileId, confirmUserId: userId });
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
