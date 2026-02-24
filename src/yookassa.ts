/**
 * YooKassa API v3: create payment and handle webhook.
 */

import { env } from './config.js';
import { logger } from './logger.js';

const YOO_KASSA_API = 'https://api.yookassa.ru/v3';

export interface CreatePaymentResult {
  id: string;
  status: string;
  confirmation_url: string;
}

/** Create a payment; returns confirmation_url for redirect. Amount in rubles. */
export async function createPayment(
  amountRub: number,
  userId: number,
  description?: string
): Promise<CreatePaymentResult | null> {
  const shopId = env.YOO_KASSA_SHOP_ID?.trim();
  const secret = env.YOO_KASSA_SECRET_KEY?.trim();
  if (!shopId || !secret) {
    logger.warn('YooKassa: missing YOO_KASSA_SHOP_ID or YOO_KASSA_SECRET_KEY');
    return null;
  }

  const value = (Math.round(amountRub * 100) / 100).toFixed(2);
  const body = {
    amount: { value, currency: 'RUB' },
    description: description ?? `Задаток Орлятник 21+`,
    metadata: { user_id: String(userId) },
    confirmation: {
      type: 'redirect',
      return_url: 'https://t.me/', // user returns to Telegram after payment
    },
    capture: true,
  };

  const auth = Buffer.from(`${shopId}:${secret}`).toString('base64');
  const idempotenceKey = `orlyatnik_${userId}_${Date.now()}`;

  try {
    const res = await fetch(`${YOO_KASSA_API}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
        'Idempotence-Key': idempotenceKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error('YooKassa createPayment failed', { status: res.status, body: errText });
      return null;
    }

    const data = (await res.json()) as {
      id: string;
      status: string;
      confirmation?: { confirmation_url?: string };
    };
    const confirmation_url = data.confirmation?.confirmation_url ?? '';
    if (!confirmation_url) {
      logger.error('YooKassa createPayment: no confirmation_url', { id: data.id });
      return null;
    }
    return {
      id: data.id,
      status: data.status,
      confirmation_url,
    };
  } catch (e) {
    logger.error('YooKassa createPayment error', { error: String(e) });
    return null;
  }
}

export function isYooKassaEnabled(): boolean {
  return !!(env.YOO_KASSA_SHOP_ID?.trim() && env.YOO_KASSA_SECRET_KEY?.trim());
}

/** Webhook payload from YooKassa (payment.succeeded etc.). */
export interface YooKassaWebhookPayload {
  type?: string;
  event?: string;
  object?: {
    id?: string;
    status?: string;
    metadata?: { user_id?: string };
  };
}

/**
 * Handle YooKassa HTTP notification. Returns HTTP status code to respond with.
 * On payment.succeeded: find participant by metadata.user_id and yookassa_payment_id, set PAYMENT_SENT, notify admin and user.
 */
export async function handleYooKassaWebhook(
  body: YooKassaWebhookPayload,
  deps: {
    getParticipantByUserId: (userId: number) => Promise<{ user_id: string; chat_id: string; status: string; yookassa_payment_id?: string } | null>;
    updateUserFields: (userId: number, patch: { status: string }) => Promise<unknown>;
    invalidateCache: (userId: number) => void;
    sendToUser: (chatId: string, text: string) => Promise<void>;
    sendToAdmin: (text: string, confirmUserId?: number) => Promise<void>;
    STATUS: { WAIT_PAYMENT: string; PAYMENT_SENT: string };
  }
): Promise<number> {
  if (body.event !== 'payment.succeeded' || !body.object?.id) {
    return 200;
  }
  const paymentId = body.object.id;
  const userIdStr = body.object.metadata?.user_id;
  if (!userIdStr) {
    logger.warn('YooKassa webhook: no user_id in metadata', { paymentId });
    return 200;
  }
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId)) {
    return 200;
  }

  const p = await deps.getParticipantByUserId(userId);
  if (!p || p.status !== deps.STATUS.WAIT_PAYMENT) {
    return 200;
  }
  if (p.yookassa_payment_id !== paymentId) {
    return 200;
  }

  await deps.updateUserFields(userId, { status: deps.STATUS.PAYMENT_SENT });
  deps.invalidateCache(userId);

  try {
    await deps.sendToUser(p.chat_id, 'Оплата получена! Можешь прислать чек сюда для сверки — тогда менеджер быстрее подтвердит. Если не пришлёшь — мы всё равно обработаем оплату.');
  } catch (e) {
    logger.error('YooKassa: send to user failed', { userId, error: String(e) });
  }
  try {
    await deps.sendToAdmin(`Оплата по ЮKassa получена.\nuser_id: ${p.user_id}\npayment_id: ${paymentId}\nПодтверди кнопкой после проверки.`, userId);
  } catch (e) {
    logger.error('YooKassa: send to admin failed', { error: String(e) });
  }

  logger.info('YooKassa payment.succeeded processed', { userId, paymentId });
  return 200;
}
