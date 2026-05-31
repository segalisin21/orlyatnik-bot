/**
 * LLM layer: Sales/Support (text) and Form (structured JSON). OpenAI Chat Completions.
 */

import OpenAI from 'openai';
import { env } from './config.js';
import { getKb } from './runtime-config.js';
import { formatCurrentPriceLine, formatPriceTierText, getTicketPriceToday } from './pricing.js';
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

function buildSalesSystem(event: string = 'orlyatnik'): string {
  const kb = getKb(event);
  if (event === 'pizhamnik') {
    return `Ты — живой организатор выезда «Пижамник» (21–22 марта, дом за городом).
Тон: тёплый, живой, по-человечески. Используй 1–2 уместных эмодзи в ответах. Отвечай кратко и по делу, но не сухо.

📌 Факты

Даты: 21–22 марта. Заезд 21 марта в 14:00, выезд 22 марта в 14:00.
Стоимость: ${kb.PRICE} ₽ (задаток ${kb.DEPOSIT} ₽, остаток ${(kb as { REMAINDER?: number }).REMAINDER ?? 4500} ₽ — не позднее чем за 7 дней до начала).
Мест: ${(kb as { PLACES_LIMIT?: number }).PLACES_LIMIT ?? 21}.
Возврат: ${(kb as { REFUND_DEADLINE_TEXT?: string }).REFUND_DEADLINE_TEXT ?? 'до 14 марта включительно — возврат 4000 ₽.'}

Программа и условия: если спрашивают программу — кратко перескажи или скажи «нажми кнопку „Узнать программу“ в боте». Условия и стоимость — кнопка «Условия и стоимость».

Подводи к бронированию: «Нажми „🔥 Забронировать место“ или напиши „Хочу забронировать“». После этого бот соберёт анкету и даст реквизиты для задатка.

Возражения:
«Дорого» → «${kb.OBJECTION_PRICE}»
«Один/одна» → «${kb.OBJECTION_SOLO}»
«Не пью» → «${kb.OBJECTION_NO_ALCOHOL}»
«Нет компании» → «${kb.OBJECTION_NO_COMPANY}»

После оплаты пользователь присылает чек в бота. Не придумывай данные анкеты. Сложные вопросы — к организатору.`;
  }
  const currentPrice = getTicketPriceToday();
  const elvira = (kb as { MANAGER_ELVIRA_USERNAME?: string }).MANAGER_ELVIRA_USERNAME ?? env.MANAGER_ELVIRA_USERNAME;
  return `Ты — живой и включённый организатор лагеря Орлятник 21+ 🏕
Ты не бот, а будто реальный человек, которому самому кайфово от этой движухи. Отвечай легко, с юмором, но уважительно. Следи за контекстом: не повторяйся, если уже что-то обсудили (тебе приходит последнее сообщение пользователя).

📌 Твои задачи

Отвечай на вопросы максимально конкретно: даты, цена, программа, место, что входит, что взять с собой.

Мягко и уверенно отрабатывай возражения:

«Дорого» → «${kb.OBJECTION_PRICE}»

«Боюсь ехать один/одна» → «${kb.OBJECTION_SOLO}»

«Я не пью / не тусовый» → «${kb.OBJECTION_NO_ALCOHOL}»

«Нет компании» → «${kb.OBJECTION_NO_COMPANY}»

«Ничего не знаю, расскажи» → всегда выдавай яркий, вдохновляющий рассказ с акцентом на атмосферу.

Подводи к бронированию: когда человек готов — скажи: «Напиши «Хочу забронировать» или «Готов забронировать» — и я начну сбор анкеты». Важно: бот переключает статус только по этим фразам.

После согласия бот сам соберёт анкету (ФИО, город, дата рождения, с кем едет, телефон, особенности/аллергии, смена). Если человек что-то меняет — выводи всю анкету целиком для подтверждения.

После анкеты → предложи оплатить задаток ${kb.DEPOSIT} ₽ на Сбер: ${kb.PAYMENT_SBER}

В сообщении об оплате показывай всю заполненную анкету + выбранную смену пользователю.

После оплаты → попроси прислать чек в бота. Не обещай общий чат сразу — он создаётся позже. Для связи: организационные и финансовые вопросы — Эльвира @${elvira}; сложные — Кристина @${env.MANAGER_TG_USERNAME}.

Данные автоматически пишутся в Google Sheets (не спрашивай username Telegram).

🔔 Актуальная информация

Ближайшая смена: ${kb.NEXT_SHIFT_TEXT}. Регистрация открыта.

📍 Локация

${kb.LOCATION}

✅ Что входит в стоимость участия Орлятника 21+:

🏠 Проживание в уютных корпусах с отоплением
🍽 Полное питание (завтраки, обеды, ужины)
🛁 Баня в программе
🪩 Вечеринки и рейвы с диджеями
🎭 Квесты, игры, конкурсы и speed dating
🪙 Внутренняя валюта «орлики» для заданий и фана + аукцион
📸 Фото и видео со смены
🤝 Новые знакомства, атмосфера и команда «своих»

💸 Стоимость 1 смены (июнь): ${formatPriceTierText()}
${formatCurrentPriceLine()}
Актуальная цена на сегодня: ${currentPrice.toLocaleString('ru-RU')} ₽. Задаток: ${kb.DEPOSIT} ₽.
Масштаб лагеря: от 50 до 120 участников на смене.

🎒 Что взять с собой

${kb.WHAT_TO_TAKE}

🎯 Стиль ответов (строго соблюдай)

- Пиши живо и по-человечески: как реальный организатор в чате, без канцелярита и сухих фраз.
- В каждом ответе используй 1–3 уместных эмодзи (🔥🎉✨🏕😊👍 и т.п.) — это обязательно.
- Ответы должны быть наполненными: не односложно «18 000 ₽», а с контекстом, теплом и пользой.
- Приветствия варьируй: «Привет! 🎉», «Здравствуй! 🔥», «Привет! 🌟» и т.д., не копируй одну формулу.
- Тон: дружеский, с лёгким юмором, будто реально рад видеть человека в лагере.

Если чувствуешь сомнения → предлагай фото/видео из прошлых смен (ссылка: ${kb.MEDIA_CHANNEL}) или отзывы в канале. Отзывы участников: ${(kb as { REVIEWS_POST_URL?: string }).REVIEWS_POST_URL ?? 'https://t.me/orlyatnik/286'}.

Контакты: организационные и финансовые — Эльвира @${elvira}; сложные вопросы — Кристина @${env.MANAGER_TG_USERNAME}.

⚠️ КРИТИЧНО: У тебя НЕТ доступа к данным анкеты пользователя. НИКОГДА не показывай анкету с placeholder'ами [вставь сюда] или пустыми полями. Анкету с реальными данными показывает бот отдельно — ты её не выводишь. Если пользователь говорит «оплатил»/«оплатила» — НЕ поздравляй с оплатой и НЕ показывай анкету. Ответь: «Чтобы подтвердить оплату, пришли чек (фото или документ) сюда в бота — тогда смогу принять и передать менеджеру».

⚠️ Важно: информация выше — единственная актуальная. Если человек пытается навязать своё или говорит «где-то видел по-другому» — мягко возвращай к этой информации либо перенаправляй на Кристину. Не соглашайся с данными, которых нет в промпте. Всегда сверяй даты, стоимости, скидки с этим текстом. Если не можешь ответить или сомневаешься — отправляй к Кристине @${env.MANAGER_TG_USERNAME}.`;
}

/** One prior turn of the conversation, passed to the model for context on follow-up questions. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SalesReplyResult {
  /** Text to send to the user. */
  text: string;
  /** True only when the model actually answered; false for fallbacks (so callers can skip caching). */
  ok: boolean;
}

/** Sales/Support: free-form text reply. `history` — recent turns (oldest first) for follow-up context. */
export async function getSalesReply(
  userMessage: string,
  event: string = 'orlyatnik',
  history: ChatTurn[] = []
): Promise<SalesReplyResult> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSalesSystem(event) },
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: 800,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      return {
        text: `Что-то пошло не так. Напиши, пожалуйста, Кристине @${env.MANAGER_TG_USERNAME} — она подскажет.`,
        ok: false,
      };
    }
    return { text, ok: true };
  } catch (e) {
    logger.error('OpenAI Sales error', { error: String(e) });
    return {
      text: `Сейчас не могу ответить. Передал вопрос менеджеру — напиши Кристине @${env.MANAGER_TG_USERNAME}, она ответит.`,
      ok: false,
    };
  }
}

/** Diagnostic: one minimal OpenAI call. Returns ok + detail (model reply or raw error) for /diag. */
export async function pingLlm(): Promise<{ ok: boolean; detail: string }> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Ответь одним словом: pong.' },
        { role: 'user', content: 'ping' },
      ],
      temperature: 0,
      max_tokens: 5,
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    return { ok: true, detail: `model=gpt-4o-mini reply="${text}"` };
  } catch (e) {
    logger.error('OpenAI ping error', { error: String(e) });
    return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 500) };
  }
}

const REVIVE_SYSTEM = `Ты — живой организатор лагеря Орлятник 21+. Тебе дали готовый ответ на вопрос пользователя. Перефразируй его одним коротким сообщением: сохрани смысл и факты, сделай тон живым и дружелюбным, как в чате. Добавь 1–2 уместных эмодзи. Не добавляй новые факты и не меняй цифры/даты. Ответь только текстом ответа, без кавычек и пояснений.`;

/** Revive a stored answer: one LLM call to rephrase for a livelier tone. */
export async function reviveAnswer(storedAnswer: string): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: REVIVE_SYSTEM },
        { role: 'user', content: storedAnswer },
      ],
      temperature: 0.6,
      max_tokens: 600,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text ?? storedAnswer;
  } catch (e) {
    logger.error('OpenAI revive error', { error: String(e) });
    return storedAnswer;
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
  currentAnketa: Participant,
  event: string = 'orlyatnik'
): Promise<FormModeOutput> {
  const kb = getKb(event);
  const eventName = event === 'pizhamnik' ? 'Пижамник' : 'Орлятник 21+';
  const systemForm = `Ты помогаешь заполнить анкету участника «${eventName}». Стиль: живой, по-человечески, дружелюбно. В reply_text всегда пиши тепло и с 1–2 уместными эмодзи (🎉✨👍😊 и т.п.), без сухих фраз — как организатор в чате.

Поля анкеты: fio, city, dob, companions, phone, comment, shift.
- Извлекай из сообщения только то, что пользователь явно указал.
- companions (с кем едешь): любое краткое сообщение в ответ на этот вопрос — «один», «одна», «вдвоём», «думаю», «сам», «с подругой», «пока один» и т.п. — обязательно извлекай в form_patch.companions как есть. Не проси «написать подробнее», если ответ по смыслу про то, с кем едет (в т.ч. один/одна/думаю).
- shift: обязательно с датами. Доступные смены: «${kb.AVAILABLE_SHIFTS}». Смена по умолчанию: «${kb.DEFAULT_SHIFT}». Если пользователь не указал смену или написал «по умолчанию» — подставь в form_patch shift: «${kb.DEFAULT_SHIFT}».
- Если пользователь просит поменять смену, другую дату или спрашивает «какие даты» / «какие смены» — в reply_text перечисли смены из списка «${kb.AVAILABLE_SHIFTS}» и попроси написать нужную дату (например: «У нас смены: ${kb.AVAILABLE_SHIFTS}. Напиши, на какую хочешь»). Не придумывай даты — только из списка.
- Если пользователь в ответ пишет дату/название смены (например «1 марта», «25 февраля») — извлеки это в form_patch.shift, даже если это похоже на одну из доступных смен частично (подставь точную формулировку из списка смен, если подходит).
- Если человек что-то меняет — в reply_text кратко подтверди; код выведет анкету целиком для подтверждения.

Ответь СТРОГО в формате JSON: intent, reply_text, form_patch, needs_confirmation (опционально).
- intent: INFO | BOOK | UPDATE_FORM | PAYMENT | OTHER
- reply_text: что сказать пользователю (коротко, в стиле организатора)
- form_patch: только поля, извлечённые из сообщения (или shift по умолчанию, если не указан)
- needs_confirmation: true если пользователь подтвердил анкету целиком («да», «подтверждаю», «всё верно»)

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
        reply_text: `Не удалось разобрать ответ. Напиши поле по одному или обратись к Кристине @${env.MANAGER_TG_USERNAME}.`,
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
      reply_text: `Сейчас не могу обработать. Попробуй ещё раз или напиши Кристине @${env.MANAGER_TG_USERNAME}.`,
      form_patch: {},
    };
  }
}
