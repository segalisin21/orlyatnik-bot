/**
 * Bootstrap: webhook or long-poll, HTTP server, cron for final messages.
 */

import express from 'express';
import cron from 'node-cron';
import { webhookCallback } from 'grammy';
import { env } from './config.js';
import { logger } from './logger.js';
import { loadSheetConfig, getKb } from './runtime-config.js';
import { createBot } from './bot.js';
import {
  getParticipantsPendingFinalSend,
  getParticipantsForReminders,
  updateParticipantRow,
  getParticipantByYookassaPayment,
  getParticipantsForPizhamnikReminder,
  verifySheetsAtStartup,
  type Participant,
} from './sheets.js';
import { invalidateCache, STATUS } from './fsm.js';
import { handleYooKassaWebhook } from './yookassa.js';
import { InlineKeyboard } from 'grammy';
import { sendPostRegistrationFlow } from './post-registration.js';

let bot: ReturnType<typeof createBot>;

const REMINDER_INACTIVE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days without activity
const REMINDER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // don't remind same user more than once per 7 days

const REMINDER_BY_STATUS: Record<string, string> = {
  NEW: 'Привет! Ты спрашивал про Орлятник — хочешь продолжить? Напиши «хочу забронировать» или задай вопрос.',
  INFO: 'Привет! Ты спрашивал про Орлятник — хочешь продолжить? Напиши «хочу забронировать» или задай вопрос.',
  FORM_FILLING:
    'Мы начали заполнять анкету — давай продолжим? Напиши следующий ответ или «подтверждаю», если всё верно.',
  FORM_CONFIRM:
    'Мы начали заполнять анкету — давай продолжим? Напиши следующий ответ или «подтверждаю», если всё верно.',
  WAIT_PAYMENT:
    'Напоминаем: чтобы подтвердить оплату, пришли чек (фото или документ) сюда в бота.',
  PAYMENT_SENT:
    'Мы получили твой чек, менеджер скоро проверит. Если есть вопросы — пиши.',
};

const REMINDER_PIZHAMNIK_BY_STATUS: Record<string, string> = {
  NEW: 'Привет! Ты спрашивал про Пижамник — хочешь забронировать место? Напиши «хочу забронировать» или нажми кнопку в боте.',
  INFO: 'Привет! Ты спрашивал про Пижамник — хочешь забронировать место? Напиши «хочу забронировать» или нажми кнопку в боте.',
  FORM_FILLING:
    'Мы начали заполнять анкету — давай продолжим? Напиши следующий ответ или «подтверждаю», если всё верно.',
  FORM_CONFIRM:
    'Мы начали заполнять анкету — давай продолжим? Напиши следующий ответ или «подтверждаю», если всё верно.',
  WAIT_PAYMENT:
    'Напоминаем: чтобы подтвердить оплату, пришли чек (фото или документ) сюда в бота.',
  PAYMENT_SENT:
    'Мы получили твой чек, менеджер скоро проверит. Если есть вопросы — пиши.',
};

async function sendFinalToParticipant(p: Participant): Promise<void> {
  const ev = p.event === 'pizhamnik' ? 'pizhamnik' : 'orlyatnik';
  await sendPostRegistrationFlow(bot.api, p.chat_id, ev, p.shift);
}

/** При нескольких строках на один chat_id — одно сообщение, обновляем все строки. */
function sortParticipantsNewestFirst(a: Participant, b: Participant): number {
  const sheetRank = (s: string | undefined) => (s === 'Пижамник' ? 1 : 0);
  const oa = sheetRank(a.sheetSource);
  const ob = sheetRank(b.sheetSource);
  if (oa !== ob) return ob - oa;
  return (b.rowIndex ?? 0) - (a.rowIndex ?? 0);
}

async function cronJob(): Promise<void> {
  try {
    const list = await getParticipantsPendingFinalSend();
    const byChat = new Map<string, Participant[]>();
    for (const p of list) {
      const cid = p.chat_id?.trim();
      if (!cid) continue;
      if (!byChat.has(cid)) byChat.set(cid, []);
      byChat.get(cid)!.push(p);
    }
    for (const group of byChat.values()) {
      try {
        const sorted = [...group].sort(sortParticipantsNewestFirst);
        const first = sorted[0]!;
        await sendFinalToParticipant(first);
        const now = new Date().toISOString();
        for (const p of group) {
          await updateParticipantRow(p, { final_sent_at: now });
        }
        invalidateCache(Number(first.user_id));
        logger.info('Final message sent', { user_id: first.user_id, rows: group.length });
      } catch (e) {
        logger.error('Cron: send final failed', { user_id: group[0]?.user_id, error: String(e) });
      }
    }
  } catch (e) {
    logger.error('Cron job error', { error: String(e) });
  }
}

async function reminderJob(): Promise<void> {
  try {
    const list = await getParticipantsForReminders(REMINDER_INACTIVE_MS, REMINDER_COOLDOWN_MS);
    const delayMs = 80;
    const reminders = (p: { status: string; event?: string }) =>
      (p.event === 'pizhamnik' ? REMINDER_PIZHAMNIK_BY_STATUS : REMINDER_BY_STATUS)[p.status] ??
      (p.event === 'pizhamnik' ? REMINDER_PIZHAMNIK_BY_STATUS.NEW : REMINDER_BY_STATUS.NEW);
    const byChat = new Map<string, Participant[]>();
    for (const p of list) {
      const cid = p.chat_id?.trim();
      if (!cid) continue;
      if (!byChat.has(cid)) byChat.set(cid, []);
      byChat.get(cid)!.push(p);
    }
    for (const group of byChat.values()) {
      try {
        const sorted = [...group].sort(sortParticipantsNewestFirst);
        const p0 = sorted[0]!;
        const text = reminders(p0);
        await bot.api.sendMessage(p0.chat_id, text);
        const now = new Date().toISOString();
        for (const p of group) {
          await updateParticipantRow(p, { last_reminder_at: now });
        }
        invalidateCache(Number(p0.user_id));
        logger.info('Reminder sent', { user_id: p0.user_id, status: p0.status, rows: group.length });
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (e) {
        logger.error('Reminder send failed', { user_id: group[0]?.user_id, error: String(e) });
      }
    }
  } catch (e) {
    logger.error('Reminder job error', { error: String(e) });
  }
}

async function pizhamnikBalanceReminderJob(): Promise<void> {
  try {
    const list = await getParticipantsForPizhamnikReminder();
    if (list.length === 0) return;
    const kb = getKb('pizhamnik');
    const text = kb.REMAINDER_REMINDER_TEXT ?? 'Напоминание: остаток 4500 ₽ за Пижамник нужно внести не позднее 14 марта.';
    const delayMs = 80;
    for (const p of list) {
      try {
        await bot.api.sendMessage(p.chat_id, text);
        logger.info('Pizhamnik balance reminder sent', { user_id: p.user_id });
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (e) {
        logger.error('Pizhamnik reminder send failed', { user_id: p.user_id, error: String(e) });
      }
    }
  } catch (e) {
    logger.error('Pizhamnik balance reminder job error', { error: String(e) });
  }
}

function startCron(): void {
  cron.schedule('*/2 * * * *', cronJob, { timezone: 'Europe/Moscow' });
  cron.schedule('0 10 * * *', reminderJob, { timezone: 'Europe/Moscow' }); // daily at 10:00
  cron.schedule('0 10 11 3 *', pizhamnikBalanceReminderJob, { timezone: 'Europe/Moscow' }); // 11 March 10:00 — 10 days before 21 March
  logger.info('Cron: final send every 2 min, reminders daily at 10:00, Pizhamnik balance reminder 11 March');
}

function adminChatIds(): number[] {
  return env.ADMIN_CHAT_IDS.length > 0 ? env.ADMIN_CHAT_IDS : env.ADMIN_CHAT_ID ? [env.ADMIN_CHAT_ID] : [];
}

async function main(): Promise<void> {
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', { reason: String(reason), stack: reason instanceof Error ? reason.stack : undefined });
  });

  await loadSheetConfig();
  await verifySheetsAtStartup();
  bot = createBot();

  const app = express();
  app.use(express.json());

  app.post('/yookassa-webhook', async (req, res) => {
    try {
      const status = await handleYooKassaWebhook(req.body, {
        getParticipantByYookassaPayment,
        updateParticipantRow: (p, patch) => updateParticipantRow(p as Participant, patch),
        invalidateCache,
        sendToUser: async (chatId, text) => {
          await bot.api.sendMessage(chatId, text);
        },
        sendToAdmin: async (text, confirmUserId) => {
          const ids = adminChatIds();
          const keyboard = confirmUserId
            ? new InlineKeyboard().text('✅ Подтвердить оплату', `confirm_${confirmUserId}`)
            : undefined;
          for (const chatId of ids) {
            await bot.api.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {});
          }
        },
        STATUS,
      });
      res.status(status).send(status === 200 ? 'ok' : '');
    } catch (e) {
      logger.error('YooKassa webhook error', { error: String(e) });
      res.status(500).send('error');
    }
  });

  app.get('/health', (_req, res) => {
    res.status(200).send('ok');
  });

  if (env.TELEGRAM_MODE === 'webhook') {
    app.post(
      '/webhook',
      webhookCallback(bot, 'express', {
        ...(env.WEBHOOK_SECRET ? { secretToken: env.WEBHOOK_SECRET } : {}),
        timeoutMilliseconds: 60000,
      })
    );
  }

  const port = env.PORT || 3000;
  app.listen(port, () => {
    logger.info('HTTP server listening', { port, mode: env.TELEGRAM_MODE });
  });
  startCron();

  if (env.TELEGRAM_MODE !== 'webhook') {
    bot.start({
      onStart: (info) => logger.info('Bot started', { username: info.username }),
    });
  }
}

main().catch((e) => {
  logger.error('Fatal', { error: String(e), stack: (e as Error).stack });
  process.exit(1);
});
