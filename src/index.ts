/**
 * Bootstrap: webhook or long-poll, HTTP server, cron for final messages.
 */

import express from 'express';
import cron from 'node-cron';
import { webhookCallback } from 'grammy';
import { env } from './config.js';
import { logger } from './logger.js';
import { createBot } from './bot.js';
import { getParticipantsPendingFinalSend } from './sheets.js';
import { updateUserFields } from './sheets.js';
import { invalidateCache } from './fsm.js';

const bot = createBot();

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

function startCron(): void {
  cron.schedule('*/2 * * * *', cronJob, { timezone: 'Europe/Moscow' });
  logger.info('Cron scheduled every 2 minutes');
}

function main(): void {
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

main();
