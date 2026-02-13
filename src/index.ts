/**
 * Bootstrap: webhook or long-poll, HTTP server, cron for final messages.
 */

import express from 'express';
import cron from 'node-cron';
import { webhookCallback } from 'grammy';
import { env } from './config.js';
import { logger } from './logger.js';
import { loadSheetConfig } from './runtime-config.js';
import { createBot } from './bot.js';
import {
  getParticipantsPendingFinalSend,
  getParticipantsForReminders,
  updateUserFields,
} from './sheets.js';
import { invalidateCache } from './fsm.js';

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

async function sendFinalToParticipant(chatId: string, managerUsername: string, chatInviteLink: string): Promise<void> {
  const text = `Ты в списке!\n\nЧат участников: ${chatInviteLink || '—'}\nМенеджер: @${managerUsername}`;
  await bot.api.sendMessage(chatId, text);
}

async function cronJob(): Promise<void> {
  try {
    const list = await getParticipantsPendingFinalSend();
    for (const p of list) {
      try {
        await sendFinalToParticipant(p.chat_id, env.MANAGER_TG_USERNAME, env.CHAT_INVITE_LINK);
        const now = new Date().toISOString();
        await updateUserFields(Number(p.user_id), { final_sent_at: now });
        invalidateCache(Number(p.user_id));
        logger.info('Final message sent', { user_id: p.user_id });
      } catch (e) {
        logger.error('Cron: send final failed', { user_id: p.user_id, error: String(e) });
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
    for (const p of list) {
      try {
        const text = REMINDER_BY_STATUS[p.status] ?? REMINDER_BY_STATUS.NEW;
        await bot.api.sendMessage(p.chat_id, text);
        const now = new Date().toISOString();
        await updateUserFields(Number(p.user_id), { last_reminder_at: now });
        invalidateCache(Number(p.user_id));
        logger.info('Reminder sent', { user_id: p.user_id, status: p.status });
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (e) {
        logger.error('Reminder send failed', { user_id: p.user_id, error: String(e) });
      }
    }
  } catch (e) {
    logger.error('Reminder job error', { error: String(e) });
  }
}

function startCron(): void {
  cron.schedule('*/2 * * * *', cronJob, { timezone: 'Europe/Moscow' });
  cron.schedule('0 10 * * *', reminderJob, { timezone: 'Europe/Moscow' }); // daily at 10:00
  logger.info('Cron: final send every 2 min, reminders daily at 10:00 Moscow');
}

async function main(): Promise<void> {
  await loadSheetConfig();
  bot = createBot();

  if (env.TELEGRAM_MODE === 'webhook') {
    const app = express();
    app.use(express.json());

    app.post(
      '/webhook',
      webhookCallback(bot, 'express', env.WEBHOOK_SECRET ? { secretToken: env.WEBHOOK_SECRET } : undefined)
    );

    app.get('/health', (_req, res) => {
      res.status(200).send('ok');
    });

    const port = env.PORT || 3000;
    app.listen(port, () => {
      logger.info('Webhook server listening', { port });
    });
    startCron();
  } else {
    bot.start({
      onStart: (info) => logger.info('Bot started', { username: info.username }),
    });
    startCron();
  }
}

main().catch((e) => {
  logger.error('Fatal', { error: String(e), stack: (e as Error).stack });
  process.exit(1);
});
