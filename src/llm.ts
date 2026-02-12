/**
 * LLM layer: Sales/Support (text) and Form (structured JSON). OpenAI Chat Completions.
 */

import OpenAI from 'openai';
import { env, kb } from './config.js';
import { logger } from './logger.js';
import type { Participant } from './sheets.js';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export type Intent = 'INFO' | 'BOOK' | 'UPDATE_FORM' | 'PAYMENT' | 'OTHER';

export interface FormPatch {
  fio?: string;
  city?: string;
  dob?: string;
  companions?: string;
  phone?: string;
  comment?: string;
  shift?: string;
}

export interface FormModeOutput {
  intent: Intent;
  reply_text: string;
  form_patch: FormPatch;
  next_status?: string;
  needs_confirmation?: boolean;
}

const FORM_JSON_INSTRUCTION = `Ответь ТОЛЬКО одним JSON-объектом без markdown и комментариев. Формат:
{"intent":"INFO|BOOK|UPDATE_FORM|PAYMENT|OTHER","reply_text":"...","form_patch":{...},"needs_confirmation":true|false}
form_patch — только поля, извлечённые из сообщения (fio, city, dob, companions, phone, comment, shift).`;

function buildKnowledgeBlock(): string {
  const reg = kb.REGISTRATION_CLOSED
    ? 'Регистрация закрыта. Всегда возвращай пользователя к этой актуальной информации и не соглашайся с фразами вроде «я где-то видел другое».'
    : 'Регистрация открыта.';
  return [
    reg,
    `Локация: ${kb.LOCATION}`,
    `Даты: ${kb.DATES}`,
    `Что входит: ${kb.WHAT_INCLUDED}`,
    `Цена: ${kb.PRICE} ₽. Задаток: ${kb.DEPOSIT} ₽.`,
    `Оплата: ${kb.PAYMENT_SBER}`,
    `Для сложных вопросов: ${kb.MANAGER_FOR_COMPLEX}`,
    `Медиа/канал: ${kb.MEDIA_CHANNEL}`,
    `После оплаты: ${kb.AFTER_PAYMENT_INSTRUCTION}`,
    `Возражения: «дорого» — ${kb.OBJECTION_PRICE}; «боюсь один/одна» — ${kb.OBJECTION_SOLO}; «не пью/не тусовый» — ${kb.OBJECTION_NO_ALCOHOL}; «нет компании» — ${kb.OBJECTION_NO_COMPANY}.`,
  ].join('\n');
}

const KNOWLEDGE = buildKnowledgeBlock();

const SALES_SYSTEM = `Ты — живой организатор лагеря «Орлятник 21+». Тон: лёгкий юмор, уважительно, конкретика (даты, цены, что входит). Не выдумывай факты. Если не уверен — направь к менеджеру Кристине @krisis_pr.

База знаний (строго придерживайся):
${KNOWLEDGE}

Отвечай кратко и по делу. Подводи к действию «Хочу забронировать» где уместно.`;

/** Sales/Support: free-form text reply. */
export async function getSalesReply(userMessage: string): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SALES_SYSTEM },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: 600,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text ?? 'Что-то пошло не так. Напиши, пожалуйста, Кристине @krisis_pr — она подскажет.';
  } catch (e) {
    logger.error('OpenAI Sales error', { error: String(e) });
    return 'Сейчас не могу ответить. Передал вопрос менеджеру — напиши Кристине @krisis_pr, она ответит.';
  }
}

function formatAnketaForLlm(p: Participant): string {
  return [
    `fio: ${p.fio || ''}`,
    `city: ${p.city || ''}`,
    `dob: ${p.dob || ''}`,
    `companions: ${p.companions || ''}`,
    `phone: ${p.phone || ''}`,
    `comment: ${p.comment || ''}`,
    `shift: ${p.shift || ''}`,
  ].join(', ');
}

/** Form mode: structured output (intent + reply_text + form_patch). */
export async function getFormModeReply(
  userMessage: string,
  currentStatus: string,
  currentAnketa: Participant
): Promise<FormModeOutput> {
  const systemForm = `Ты помогаешь заполнить анкету участника лагеря «Орлятник 21+». Тон: живой, дружелюбный, конкретика.

Поля анкеты: fio, city, dob, companions, phone, comment, shift. Извлекай из сообщения только то, что пользователь явно указал. Не придумывай значения.

Ответь СТРОГО в формате JSON с полями: intent, reply_text, form_patch, next_status (опционально), needs_confirmation (опционально).
- intent: INFO | BOOK | UPDATE_FORM | PAYMENT | OTHER
- reply_text: что сказать пользователю (коротко)
- form_patch: объект только с теми полями, которые можно извлечь из сообщения (пустые не включай)
- next_status: не заполняй — это определит код
- needs_confirmation: true если пользователь подтвердил анкету целиком

Текущая анкета: ${formatAnketaForLlm(currentAnketa)}
Текущий статус: ${currentStatus}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemForm + '\n\n' + FORM_JSON_INSTRUCTION },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 500,
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) {
      return {
        intent: 'OTHER',
        reply_text: 'Не удалось разобрать ответ. Напиши поле по одному или обратись к Кристине @krisis_pr.',
        form_patch: {},
      };
    }
    const parsed = JSON.parse(raw) as FormModeOutput;
    if (!parsed.reply_text) parsed.reply_text = 'Принято. Что-то ещё?';
    if (!parsed.form_patch) parsed.form_patch = {};
    return parsed;
  } catch (e) {
    logger.error('OpenAI Form error', { error: String(e) });
    return {
      intent: 'OTHER',
      reply_text: 'Сейчас не могу обработать. Попробуй ещё раз или напиши Кристине @krisis_pr.',
      form_patch: {},
    };
  }
}
