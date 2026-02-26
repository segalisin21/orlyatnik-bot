/**
 * Telegram bot: handlers for text, voice, photo, document. FSM-driven, LLM, Sheets.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { env, isAdmin } from './config.js';
import { getKb, updateConfigKey, loadSheetConfig, EDITABLE_KEYS, EDITABLE_KEYS_PIZHAMNIK, getShiftsList } from './runtime-config.js';
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
import { getSalesReply, getFormModeReply, reviveAnswer } from './llm.js';
import { transcribeVoice } from './voice.js';
import {
  appendLog,
  updateUserFields,
  getParticipantByUserId,
  getParticipantsForBroadcast,
  getAnswerFromStorage,
  saveAnswer,
  normalizeQuestion,
  getConfirmedCount,
} from './sheets.js';
import { invalidateCache } from './fsm.js';
import type { Participant } from './sheets.js';
import { createPayment, isYooKassaEnabled } from './yookassa.js';

function getFieldPrompts(event?: string): Record<FormField, string> {
  return getKb(event).field_prompts;
}

/** Inline keyboard: one button per shift (shift_0, shift_1, ...) + "По умолчанию" (shift_default). */
function getShiftKeyboard(event?: string): InlineKeyboard {
  const shifts = getShiftsList(event);
  const kb = new InlineKeyboard();
  shifts.forEach((_, i) => kb.text(shifts[i], `shift_${i}`));
  if (shifts.length > 0) kb.row();
  kb.text('По умолчанию', 'shift_default');
  return kb;
}

function eventChoiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Орлятник 21+', 'event_orlyatnik')
    .text('Пижамник', 'event_pizhamnik');
}

function eventStartKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Узнать программу', 'program')
    .text('Условия и стоимость', 'conditions').row()
    .text('Забронировать место', 'book_place');
}

/** Кнопки «Да» / «Подтверждаю» для перехода к оплате после проверки анкеты. */
function confirmAnketaKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Да', 'confirm_anketa_yes')
    .text('Подтверждаю', 'confirm_anketa_yes');
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

/** Phrase triggers for "choose shift" in free chat (NEW/INFO). */
const PHRASE_SHIFT_CHOICE = /(какие\s+смены|выбрать\s+смену|на\s+какую\s+смену|поменять\s+смену|какие\s+даты)/i;

export function createBot(): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  function logOut(userId: string, status: string, direction: 'IN' | 'OUT', messageType: string, textPreview: string, raw?: string) {
    appendLog({
      timestamp: new Date().toISOString(),
      user_id: userId,
      status,
      direction,
      message_type: messageType,
      text_preview: textPreview,
      raw_json: raw,
    }).catch(() => {});
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
  const adminSettingsPending = new Map<number, { key: string; event?: string }>();

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

  /** Shared text/voice handler: CONFIRMED, form flow, BOOK, shift choice, or LLM + answer storage. */
  async function handleUserText(
    ctx: { reply: (text: string, opts?: { reply_markup?: InlineKeyboard }) => Promise<unknown> },
    userId: number,
    chatId: number,
    username: string,
    text: string,
    p: Participant
  ): Promise<void> {
    const ev = (p.event ?? '').trim() || 'orlyatnik';
    const evKb = getKb(ev);

    if (p.status === STATUS.CONFIRMED) {
      await ctx.reply(
        `Ты уже в списке!\n\nЧат участников: ${env.CHAT_INVITE_LINK || '—'}\nМенеджер: @${env.MANAGER_TG_USERNAME}`
      );
      return;
    }

    if (p.status === STATUS.PAYMENT_SENT) {
      await ctx.reply('Чек уже принят, ждём подтверждения от менеджера.');
      return;
    }

    if (p.status === STATUS.WAIT_PAYMENT) {
      await ctx.reply(evKb.AFTER_PAYMENT_INSTRUCTION || PHRASE_HINT_RECEIPT);
      return;
    }

    if (p.status === STATUS.WAITLIST) {
      const msg = evKb.WAITLIST_CONFIRMED_MESSAGE ?? 'Ты в листе ожидания. Сообщим, если место освободится.';
      await ctx.reply(msg);
      return;
    }

    if (p.status === STATUS.FORM_CONFIRM) {
      if (PHRASE_CONFIRM_ANKETA.test(text)) {
        await setParticipantStatus(userId, STATUS.WAIT_PAYMENT);
        p = await getParticipant(userId, username, chatId);
        const paymentInstruction = (evKb as { PAYMENT_INSTRUCTION?: string }).PAYMENT_INSTRUCTION || `Реквизиты для задатка: ${evKb.PAYMENT_SBER}`;
        await ctx.reply(`Отлично! ${paymentInstruction}`);
        await ctx.reply(`Повторяю анкету:\n\n${formatAnketa(p)}\n\n${evKb.AFTER_PAYMENT_INSTRUCTION || PHRASE_HINT_RECEIPT}`);
        return;
      }
      await ctx.reply(PHRASE_HINT_CONFIRM, { reply_markup: confirmAnketaKeyboard() });
      return;
    }

    if (p.status === STATUS.FORM_FILLING) {
      const formOut = await getFormModeReply(text, p.status, p, ev);
      let patch = formOut.form_patch || {};
      const nextEmpty = getNextEmptyField(p);
      if (nextEmpty === 'companions' && !patch.companions && text.trim().length > 0 && text.trim().length <= 200) {
        patch = { ...patch, companions: text.trim() };
      }
      if (Object.keys(patch).length > 0) {
        const phonePatch = patch.phone != null ? { ...patch, phone: normalizePhone(patch.phone) } : patch;
        p = await patchParticipant(userId, phonePatch);
      }
      if (formOut.reply_text) await ctx.reply(formOut.reply_text);
      if (formOut.needs_confirmation && isFormComplete(p)) {
        await setParticipantStatus(userId, STATUS.FORM_CONFIRM);
        p = await getParticipant(userId, username, chatId);
        await ctx.reply(`Проверь анкету:\n\n${formatAnketa(p)}\n\n${PHRASE_HINT_CONFIRM}`, { reply_markup: confirmAnketaKeyboard() });
        return;
      }
      const next = getNextEmptyField(p);
      if (!next) {
        await setParticipantStatus(userId, STATUS.FORM_CONFIRM);
        p = await getParticipant(userId, username, chatId);
        await ctx.reply(`Проверь анкету:\n\n${formatAnketa(p)}\n\n${PHRASE_HINT_CONFIRM}`, { reply_markup: confirmAnketaKeyboard() });
        return;
      }
      const prompt = getFieldPrompts(ev)[next];
      await ctx.reply(prompt, next === 'shift' ? { reply_markup: getShiftKeyboard(ev) } : {});
      return;
    }

    if ((p.status === STATUS.NEW || p.status === STATUS.INFO) && PHRASE_BOOK.test(text)) {
      if (evKb.REGISTRATION_CLOSED) {
        await ctx.reply('Регистрация на это мероприятие сейчас закрыта.');
        return;
      }
      if (ev === 'pizhamnik') {
        const limit = evKb.PLACES_LIMIT ?? 21;
        const count = await getConfirmedCount('pizhamnik');
        if (count >= limit) {
          const waitlistKb = new InlineKeyboard().text('Записаться в лист ожидания', 'waitlist_yes');
          await ctx.reply(evKb.PLACES_FULL_MESSAGE ?? '', { reply_markup: waitlistKb });
          return;
        }
      }
      if (!p.consent_at?.trim()) {
        const consentText = evKb.CONSENT_PD_TEXT;
        const consentKb = new InlineKeyboard().text('Согласен на обработку персональных данных', 'consent_ok');
        await ctx.reply(consentText, { reply_markup: consentKb });
        return;
      }
      await setParticipantStatus(userId, STATUS.FORM_FILLING);
      p = await getParticipant(userId, username, chatId);
      const next = getNextEmptyField(p);
      const prompt = next ? getFieldPrompts(ev)[next] : '';
      await ctx.reply(prompt || PHRASE_HINT_CONFIRM, next === 'shift' ? { reply_markup: getShiftKeyboard(ev) } : {});
      return;
    }

    if ((p.status === STATUS.NEW || p.status === STATUS.INFO) && PHRASE_SHIFT_CHOICE.test(text)) {
      await ctx.reply('Выбери смену:', { reply_markup: getShiftKeyboard(ev) });
      return;
    }

    const norm = normalizeQuestion(text);
    const stored = await getAnswerFromStorage(norm);
    if (stored) {
      const revived = await reviveAnswer(stored);
      await ctx.reply(revived);
      return;
    }
    const reply = await getSalesReply(text, ev);
    await saveAnswer(text, reply);
    await ctx.reply(reply);
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

  const PHRASE_CONSENT = /^согласен(\s+на\s+обработку(\s+персональных\s+данных)?)?$/i;

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

      if (data === 'event_orlyatnik' || data === 'event_pizhamnik') {
        const uid = ctx.callbackQuery.from?.id;
        const chatId = ctx.callbackQuery.message?.chat?.id;
        const username = ctx.callbackQuery.from?.username ?? '';
        if (!uid || !chatId) {
          await safeAnswer();
          return;
        }
        await safeAnswer('Записываю…');
        const event = data === 'event_orlyatnik' ? 'orlyatnik' : 'pizhamnik';
        const patch: { event: string; shift?: string } = { event };
        if (event === 'pizhamnik') patch.shift = getKb('pizhamnik').DEFAULT_SHIFT;
        // Run Sheets + reply in background so webhook returns before Telegram timeout
        const chatIdForBg = chatId;
        void (async () => {
          const run = async () => {
            await getParticipant(uid, username, chatIdForBg);
            await patchParticipant(uid, patch);
          };
          try {
            await run();
          } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            if (msg.includes('Participant not found')) {
              invalidateCache(uid);
              try {
                await run();
              } catch (e2) {
                logger.error('patchParticipant event failed (retry)', { userId: uid, error: String(e2) });
                try {
                  await bot.api.sendMessage(chatIdForBg, 'Ошибка, попробуй ещё раз.');
                } catch (_) {}
                return;
              }
            } else {
              logger.error('patchParticipant event failed', { userId: uid, error: msg });
              try {
                await bot.api.sendMessage(chatIdForBg, 'Ошибка, попробуй ещё раз.');
              } catch (_) {}
              return;
            }
          }
          try {
          const menuKb = eventStartKeyboard();
          const kb = getKb(event === 'pizhamnik' ? 'pizhamnik' : 'orlyatnik');
          await bot.api.sendMessage(chatIdForBg, kb.START_MESSAGE ?? 'Добро пожаловать! Выбери кнопку или напиши вопрос в чат.', { reply_markup: menuKb });
          } catch (e) {
            logger.error('Event choice: send reply failed', { userId: uid, error: String(e) });
          }
        })();
        return;
      }

      if (data === 'program' || data === 'conditions') {
        const uid = ctx.callbackQuery.from?.id;
        const chatId = ctx.callbackQuery.message?.chat?.id;
        const username = ctx.callbackQuery.from?.username ?? '';
        if (!uid || !chatId) {
          await safeAnswer();
          return;
        }
        let p: Participant;
        try {
          p = await getParticipant(uid, username, chatId);
        } catch (e) {
          await safeAnswer();
          return;
        }
        const ev = p.event ?? 'orlyatnik';
        const kb = getKb(ev);
        const text = data === 'program' ? (kb.PROGRAM_TEXT ?? '') : (kb.CONDITIONS_TEXT ?? '');
        const menuKb = ev === 'pizhamnik' ? eventStartKeyboard() : eventStartKeyboard();
        if (text) await ctx.reply(text, { reply_markup: menuKb });
        await safeAnswer();
        return;
      }

      if (data === 'book_place') {
        const uid = ctx.callbackQuery.from?.id;
        const chatId = ctx.callbackQuery.message?.chat?.id;
        const username = ctx.callbackQuery.from?.username ?? '';
        if (!uid || !chatId) {
          await safeAnswer();
          return;
        }
        let p: Participant;
        try {
          p = await getParticipant(uid, username, chatId);
        } catch (e) {
          await safeAnswer('Ошибка, попробуй ещё раз.');
          return;
        }
        const evKb = getKb(p.event || 'orlyatnik');
        if (evKb.REGISTRATION_CLOSED) {
          await ctx.reply('Регистрация на это мероприятие сейчас закрыта.');
          await safeAnswer();
          return;
        }
        if ((p.event ?? '') === 'pizhamnik') {
          const limit = evKb.PLACES_LIMIT ?? 21;
          const count = await getConfirmedCount('pizhamnik');
          if (count >= limit) {
            const waitlistKb = new InlineKeyboard().text('Записаться в лист ожидания', 'waitlist_yes');
            await ctx.reply(evKb.PLACES_FULL_MESSAGE ?? '', { reply_markup: waitlistKb });
            await safeAnswer();
            return;
          }
        }
        if (!p.consent_at?.trim()) {
          const consentText = getKb(p.event).CONSENT_PD_TEXT;
          const consentKeyboard = new InlineKeyboard().text('Согласен на обработку персональных данных', 'consent_ok');
          await ctx.reply(consentText, { reply_markup: consentKeyboard });
          await safeAnswer('Принято');
          return;
        }
        await setParticipantStatus(uid, STATUS.FORM_FILLING);
        p = await getParticipant(uid, username, chatId);
        const next = getNextEmptyField(p);
        const prompt = next ? getFieldPrompts(p.event)[next] : '';
        await ctx.reply(prompt || PHRASE_HINT_CONFIRM, next === 'shift' ? { reply_markup: getShiftKeyboard(p.event) } : {});
        await safeAnswer('Принято');
        return;
      }

      if (data === 'waitlist_yes') {
        const uid = ctx.callbackQuery.from?.id;
        const chatId = ctx.callbackQuery.message?.chat?.id;
        const username = ctx.callbackQuery.from?.username ?? '';
        if (!uid || !chatId) {
          await safeAnswer();
          return;
        }
        let p: Participant;
        try {
          p = await getParticipant(uid, username, chatId);
        } catch (e) {
          await safeAnswer('Ошибка.');
          return;
        }
        if ((p.event ?? '') !== 'pizhamnik' || (p.status !== STATUS.NEW && p.status !== STATUS.INFO)) {
          await safeAnswer();
          return;
        }
        await setParticipantStatus(uid, STATUS.WAITLIST);
        const kb = getKb('pizhamnik');
        await ctx.reply(kb.WAITLIST_CONFIRMED_MESSAGE ?? 'Записала в лист ожидания. Сообщим, если место освободится.');
        await safeAnswer('Принято');
        return;
      }

      if (data === 'consent_ok') {
        const uid = ctx.callbackQuery.from?.id;
        const chatId = ctx.callbackQuery.message?.chat?.id;
        const username = ctx.callbackQuery.from?.username ?? '';
        if (!uid || !chatId) {
          await safeAnswer();
          return;
        }
        const doConsent = async (): Promise<boolean> => {
          const p = await getParticipant(uid!, username, chatId!);
          const now = new Date().toISOString();
          if (!p.consent_at?.trim()) {
            await patchParticipant(uid!, { consent_at: now });
          }
          await setParticipantStatus(uid!, STATUS.FORM_FILLING);
          const p2 = await getParticipant(uid!, username, chatId!);
          const next = getNextEmptyField(p2);
          const prompt = next ? getFieldPrompts(p2.event)[next] : '';
          await ctx.reply(prompt || PHRASE_HINT_CONFIRM, next === 'shift' ? { reply_markup: getShiftKeyboard(p2.event) } : {});
          await safeAnswer('Принято');
          return true;
        };
        try {
          await doConsent();
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          if (msg.includes('Participant not found')) {
            invalidateCache(uid!);
            try {
              await doConsent();
            } catch (e2) {
              logger.error('Consent/setParticipant failed (retry)', { userId: uid, error: String(e2) });
              try {
                await safeAnswer('Не удалось сохранить.');
                await ctx.reply('Не получилось записать. Попробуй нажать кнопку согласия ещё раз.');
              } catch (_) {}
            }
          } else {
            logger.error('Consent/setParticipant failed', { userId: uid, error: msg });
            try {
              await safeAnswer('Не удалось сохранить.');
              await ctx.reply(
                'Не получилось записать согласие в таблицу.\n\nЕсли ты выбрал(а) Пижамник — создай в Google-таблице лист «Пижамник» с такой же первой строкой заголовков. Потом нажми кнопку согласия снова.'
              );
            } catch (_) {}
          }
        }
        return;
      }

      if (data === 'confirm_anketa_yes') {
        const uid = ctx.callbackQuery.from?.id;
        const chatId = ctx.callbackQuery.message?.chat?.id;
        const username = ctx.callbackQuery.from?.username ?? '';
        if (!uid || !chatId) {
          await safeAnswer();
          return;
        }
        let p: Participant;
        try {
          p = await getParticipant(uid, username, chatId);
        } catch (e) {
          logger.error('confirm_anketa_yes: getParticipant failed', { userId: uid, error: String(e) });
          await safeAnswer('Ошибка, попробуй ещё раз.');
          return;
        }
        if (p.status !== STATUS.FORM_CONFIRM) {
          await safeAnswer();
          return;
        }
        try {
          await setParticipantStatus(uid, STATUS.WAIT_PAYMENT);
          p = await getParticipant(uid, username, chatId);
          const evKb = getKb(p.event || 'orlyatnik');
          const paymentInstruction = (evKb as { PAYMENT_INSTRUCTION?: string }).PAYMENT_INSTRUCTION || `Реквизиты для задатка: ${evKb.PAYMENT_SBER}`;
          await safeAnswer('Принято');
          await ctx.reply(`Отлично! ${paymentInstruction}`);
          await ctx.reply(`Повторяю анкету:\n\n${formatAnketa(p)}\n\n${evKb.AFTER_PAYMENT_INSTRUCTION || PHRASE_HINT_RECEIPT}`);
        } catch (e) {
          logger.error('confirm_anketa_yes failed', { userId: uid, error: String(e) });
          try {
            await safeAnswer('Не удалось перейти к оплате.');
            await ctx.reply('Попробуй нажать кнопку ещё раз или напиши «Да» или «Подтверждаю».');
          } catch (_) {}
        }
        return;
      }

      if (data === 'change_shift') {
        await safeAnswer();
        const uid = ctx.callbackQuery.from?.id;
        const chatId = ctx.callbackQuery.message?.chat?.id;
        const username = ctx.callbackQuery.from?.username ?? '';
        let event: string | undefined;
        if (uid && chatId) {
          try {
            const p = await getParticipant(uid, username, chatId);
            event = p.event;
          } catch {
            // fallback to default
          }
        }
        await ctx.reply('Выбери смену:', { reply_markup: getShiftKeyboard(event) });
        return;
      }

      if (data.startsWith('shift_')) {
        const uid = ctx.callbackQuery.from?.id;
        const chatId = ctx.callbackQuery.message?.chat?.id;
        const username = ctx.callbackQuery.from?.username ?? '';
        if (!uid || !chatId) {
          await safeAnswer();
          return;
        }
        let p: Participant;
        try {
          p = await getParticipant(uid, username, chatId);
        } catch (e) {
          logger.error('getParticipant failed in shift callback', { userId: uid, error: String(e) });
          await safeAnswer('Ошибка, попробуй ещё раз.');
          return;
        }
        const payload = data.replace('shift_', '');
        const ev = p.event;
        const shifts = getShiftsList(ev);
        const kbEv = getKb(ev);
        const chosenShift =
          payload === 'default' ? kbEv.DEFAULT_SHIFT : shifts[Number(payload)] ?? kbEv.DEFAULT_SHIFT;
        try {
          p = await patchParticipant(uid, { shift: chosenShift });
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          if (msg.includes('Participant not found')) {
            invalidateCache(uid);
            try {
              p = await getParticipant(uid, username, chatId);
              p = await patchParticipant(uid, { shift: chosenShift });
            } catch (e2) {
              logger.error('shift callback patch failed', { userId: uid, error: String(e2) });
              try {
                await safeAnswer('Ошибка, попробуй ещё раз.');
              } catch (_) {}
              return;
            }
          } else {
            throw e;
          }
        }
        await safeAnswer('Принято');
        const formStatuses: string[] = [STATUS.FORM_FILLING, STATUS.FORM_CONFIRM];
        if (formStatuses.includes(p.status)) {
          const next = getNextEmptyField(p);
          if (!next) {
            try {
              await setParticipantStatus(uid, STATUS.FORM_CONFIRM);
              p = await getParticipant(uid, username, chatId);
              const fullAnketa = formatAnketa(p);
              await ctx.reply(`Проверь анкету:\n\n${fullAnketa}\n\n${PHRASE_HINT_CONFIRM}`, { reply_markup: confirmAnketaKeyboard() });
            } catch (e) {
              logger.error('shift setParticipantStatus failed', { userId: uid, error: String(e) });
              try {
                await safeAnswer('Ошибка.');
                await ctx.reply('Не удалось обновить статус. Попробуй ещё раз.');
              } catch (_) {}
            }
          } else {
            const prompt = getFieldPrompts(p.event)[next];
            await ctx.reply(
              prompt,
              next === 'shift' ? { reply_markup: getShiftKeyboard(p.event) } : {}
            );
          }
        } else {
          await ctx.reply(
            `Записал смену: ${chosenShift}. Когда будешь готов — напиши «Хочу забронировать», эта смена подставится в анкету.`
          );
        }
        return;
      }

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
        const keyboard = new InlineKeyboard()
          .text('Орлятник', 'admin_settings_orlyatnik')
          .text('Пижамник', 'admin_settings_pizhamnik');
        await ctx.reply('⚙ Настройки. Выбери мероприятие (лист в таблице):', { reply_markup: keyboard });
        return;
      }
      if (data === 'admin_settings_orlyatnik') {
        await safeAnswer();
        const kb = getKb('orlyatnik');
        const lines = EDITABLE_KEYS.map(({ key, label }) => {
          const raw = key.startsWith('FIELD_PROMPT_') ? (kb.field_prompts as Record<string, string>)[key.replace('FIELD_PROMPT_', '')] ?? '—' : (kb as unknown as Record<string, unknown>)[key];
          const val = typeof raw === 'string' ? (raw.slice(0, 40) + (raw.length > 40 ? '…' : '')) : String(raw ?? '—');
          return `• ${label}: ${val}`;
        });
        const keyboard = new InlineKeyboard();
        EDITABLE_KEYS.forEach(({ key, label }, i) => {
          keyboard.text(label, `admin_set_o_${key}`);
          if (i % 2 === 1) keyboard.row();
        });
        await ctx.reply('⚙ Орлятник (лист «Настройки»). Пустые — из кода.\n\n' + lines.join('\n'), { reply_markup: keyboard });
        return;
      }
      if (data === 'admin_settings_pizhamnik') {
        await safeAnswer();
        const kb = getKb('pizhamnik');
        const lines = EDITABLE_KEYS_PIZHAMNIK.map(({ key, label }) => {
          const raw = (kb as unknown as Record<string, unknown>)[key];
          const val = typeof raw === 'string' ? (raw.slice(0, 40) + (raw.length > 40 ? '…' : '')) : String(raw ?? '—');
          return `• ${label}: ${val}`;
        });
        const keyboard = new InlineKeyboard();
        EDITABLE_KEYS_PIZHAMNIK.forEach(({ key, label }, i) => {
          keyboard.text(label, `admin_set_p_${key}`);
          if (i % 2 === 1) keyboard.row();
        });
        await ctx.reply('⚙ Пижамник (лист «Настройки Пижамник»). Пустые — из кода.\n\n' + lines.join('\n'), { reply_markup: keyboard });
        return;
      }
      if (data.startsWith('admin_set_o_') || data.startsWith('admin_set_p_')) {
        const isPizhamnik = data.startsWith('admin_set_p_');
        const key = data.replace(isPizhamnik ? 'admin_set_p_' : 'admin_set_o_', '');
        const keysList = isPizhamnik ? EDITABLE_KEYS_PIZHAMNIK : EDITABLE_KEYS;
        const label = keysList.find((e) => e.key === key)?.label ?? key;
        adminSettingsPending.set(fromId!, { key, event: isPizhamnik ? 'pizhamnik' : undefined });
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
      logger.error('Callback error', { data: ctx.callbackQuery.data, error: String(e), stack: (e as Error).stack });
      try {
        await safeAnswer('Ошибка, попробуй ещё раз.');
      } catch (_) {}
    } finally {
      try {
        await safeAnswer();
      } catch (_) {}
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
        const sheetLabel = settingsPending.event === 'pizhamnik' ? 'Настройки Пижамник' : 'Настройки';
        try {
          await updateConfigKey(settingsPending.key, text, settingsPending.event);
          const label = (settingsPending.event === 'pizhamnik' ? EDITABLE_KEYS_PIZHAMNIK : EDITABLE_KEYS).find((e) => e.key === settingsPending.key)?.label ?? settingsPending.key;
          await ctx.reply(`✅ Сохранено: «${label}». Значение записано в лист «${sheetLabel}» — бот уже использует его.`);
        } catch (e) {
          logger.error('Settings save error', { error: String(e), key: settingsPending.key, event: settingsPending.event });
          await ctx.reply(`Ошибка записи в таблицу. Проверь, что лист «${sheetLabel}» есть в таблице.`);
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
      if (text === '/start' || text.startsWith('/start ') || text === '/admin') {
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
      await ctx.reply(`Что-то пошло не так. Попробуй позже или напиши @${env.MANAGER_TG_USERNAME}.`);
      return;
    }
    logOut(String(userId), p.status, 'IN', 'text', text.slice(0, 200));

    if (text === '/start' || text.startsWith('/start ')) {
      const ev = (p.event ?? '').trim();
      if (!ev) {
        await ctx.reply(
          'Привет! 👋 Рады видеть тебя здесь. Выбери мероприятие — расскажем программу, условия и поможем забронировать место.',
          { reply_markup: eventChoiceKeyboard() }
        );
        return;
      }
      const kb = getKb(ev === 'pizhamnik' ? 'pizhamnik' : 'orlyatnik');
      await ctx.reply(kb.START_MESSAGE ?? 'Добро пожаловать! Выбери кнопку или напиши вопрос в чат.', { reply_markup: eventStartKeyboard() });
      return;
    }

    await handleUserText(ctx, userId, chatId, username, text, p);
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
      await ctx.reply(`Что-то пошло не так. Попробуй позже или напиши @${env.MANAGER_TG_USERNAME}.`);
      return;
    }
    logOut(String(userId), p.status, 'IN', 'voice', '[voice]');

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
    logOut(String(userId), p.status, 'IN', 'voice_transcribed', text.slice(0, 200));
    await handleUserText(ctx, userId, chatId, username, text, p);
  });

  /** Shared receipt handler for photo and document (WAIT_PAYMENT → PAYMENT_SENT, notify admin). */
  async function handleReceipt(
    ctx: { reply: (text: string) => Promise<unknown> },
    userId: number,
    chatId: number,
    username: string,
    fileId: string,
    type: 'photo' | 'document'
  ): Promise<void> {
    const p = await getParticipant(userId, username, chatId);
    if (p.status !== STATUS.WAIT_PAYMENT && p.status !== STATUS.PAYMENT_SENT) {
      await ctx.reply(
        type === 'photo'
          ? 'Фото приму как чек только после того, как заполнишь анкету и перейдёшь к оплате. Пока что напиши текстом или голосом, что хочешь узнать.'
          : 'Документ приму как чек только после анкеты и перехода к оплате. Пока напиши текстом или голосом.'
      );
      return;
    }
    if (p.status === STATUS.PAYMENT_SENT) {
      await ctx.reply('Чек уже принят, ждём подтверждения от менеджера.');
      return;
    }
    await setParticipantStatus(userId, STATUS.PAYMENT_SENT, { payment_proof_file_id: fileId });
    const updated = await getParticipant(userId, username, chatId);
    const eventLabel = updated.event === 'pizhamnik' ? 'Пижамник' : 'Орлятник 21+';
    const mediaLabel = type === 'photo' ? 'фото' : 'документ';
    const adminText = `Чек (${mediaLabel}) от участника. Мероприятие: ${eventLabel}\n@${username} (id: ${userId})\n\n${formatAnketa(updated)}\n\nНажми кнопку ниже или измени статус в таблице на CONFIRMED.`;
    await sendToAdmin(adminText, type === 'photo' ? { photo: fileId, confirmUserId: userId } : { document: fileId, confirmUserId: userId });
    await ctx.reply('Принял, ждём подтверждения. Как только менеджер подтвердит — пришлю ссылку на чат и контакт.');
    if (updated.event === 'pizhamnik') {
      const kb = getKb('pizhamnik');
      if (kb.AFTER_RECEIPT_MESSAGE) await ctx.reply(kb.AFTER_RECEIPT_MESSAGE);
    }
    logOut(String(userId), STATUS.PAYMENT_SENT, 'OUT', 'text', 'payment received');
  }

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
      await ctx.reply(`Что-то пошло не так. Попробуй позже или напиши @${env.MANAGER_TG_USERNAME}.`);
      return;
    }
    const fileId = photo[photo.length - 1].file_id;
    logOut(String(userId), p.status, 'IN', 'photo', '[photo]');
    await handleReceipt(ctx, userId, chatId, username, fileId, 'photo');
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
      await ctx.reply(`Что-то пошло не так. Попробуй позже или напиши @${env.MANAGER_TG_USERNAME}.`);
      return;
    }
    const fileId = doc.file_id;
    logOut(String(userId), p.status, 'IN', 'document', '[document]');
    await handleReceipt(ctx, userId, chatId, username, fileId, 'document');
  });

  bot.on(['message:sticker', 'message:animation', 'message:video', 'message:audio', 'message:video_note'], async (ctx) => {
    await ctx.reply('Лучше напиши текстом или голосом — так смогу помочь. Если хочешь прислать чек — отправь фото или документ после перехода к оплате.');
  });

  bot.catch((err) => {
    logger.error('Bot error', { error: err.message, stack: err.stack });
  });

  return bot;
}
