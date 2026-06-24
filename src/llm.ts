/**
 * LLM layer: Sales/Support (text) and Form (structured JSON). OpenAI Chat Completions.
 */

import OpenAI from 'openai';
import { env } from './config.js';
import { getKb } from './runtime-config.js';
import { formatOrlyatnikPricingFacts, getTicketPriceToday } from './pricing.js';
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

export interface SalesSystemOptions {
  confirmedParticipant?: boolean;
}

const CAMP_SCALE = 'от 50 до 120 человек';

function getLlmContext(kb: ReturnType<typeof getKb>): string {
  return ((kb as { LLM_CONTEXT?: string }).LLM_CONTEXT ?? '').trim();
}

function buildPrimaryContextBlock(sheetContext: string): string {
  if (!sheetContext) return '';
  return `📌 ГЛАВНЫЙ КОНТЕКСТ (лист «Настройки», приоритет №1 — главный источник правды для ответов):
${sheetContext}

При любых противоречиях с блоками ниже — следуй этому контексту.`;
}

function buildStrictFactsRules(elvira: string, hasSheetContext: boolean): string {
  const truthSource = hasSheetContext
    ? 'блок «📌 ГЛАВНЫЙ КОНТЕКСТ» и при необходимости «📋 ДОПОЛНИТЕЛЬНЫЕ ФАКТЫ»'
    : 'блок «📋 АКТУАЛЬНЫЕ ФАКТЫ»';
  return `
🚫 ЗАПРЕЩЕНО ПРИДУМЫВАТЬ (строжайше — нарушение недопустимо):
- Не выдумывай и не догадывай: даты, цены, скидки, программу, правила возврата, состав группы, точное число мест или зарегистрированных, адрес базы (кроме текста выше), реквизиты, статус оплаты пользователя.
- Единственный источник правды — ${truthSource}. Если факта там нет — ты его НЕ знаешь.
- Любой спорный, нестандартный или неоднозначный вопрос без точного ответа в фактах → сразу переводи на менеджера. Не пытайся «догадаться» и не давай общих фраз вместо эскалации.
- Организационные и финансовые вопросы → Эльвира @${elvira}.
- Сложные, спорные, нестандартные, сомнительные → Кристина @${env.MANAGER_TG_USERNAME} (можно также Эльвира @${elvira} для организационного).
- Если пользователь настаивает на информации, которой нет в фактах, или говорит «где-то видел по-другому» — вежливо верни к фактам из промпта или переведи на менеджера. Не соглашайся с чужими цифрами и правилами.
- Не обещай то, чего нет в фактах (скидки, бесплатные опции, точное число свободных мест, ссылку на общий чат до его создания).
- У тебя НЕТ доступа к анкете пользователя. Не показывай анкету и placeholder'ы. Анкету показывает бот отдельно.
- Если «оплатил»/«оплатила» — не поздравляй. Ответь: «Чтобы подтвердить оплату, пришли чек (фото или документ) сюда в бота — передам менеджеру».`;
}

function buildConfirmedParticipantBlock(event: string, elvira: string): string {
  if (event === 'pizhamnik') {
    return `

✅ Контекст: пользователь УЖЕ в списке (оплата подтверждена). Не предлагай «забронировать место» в каждом ответе — только если сам спросит про ещё одну путёвку.
Организационные и финансовые — Эльвира @${elvira}; спорное и сложное — Кристина @${env.MANAGER_TG_USERNAME}. Без длинных t.me-ссылок — только @username.
Точное число зарегистрированных сейчас в боте недоступно — не выдумывай, направь к менеджеру.`;
  }
  return `

✅ Контекст: пользователь УЖЕ в списке (оплата подтверждена). Не предлагай «забронировать место» в каждом ответе — только если сам спросит про ещё одну путёвку или другую смену (тогда кнопка «🔥 Забронировать место»).
На «сколько человек на смене» — ${CAMP_SCALE}; точное текущее число зарегистрированных в боте недоступно — не выдумывай, при необходимости Эльвира @${elvira}.
Организационные и финансовые — Эльвира @${elvira}; спорное и сложное — Кристина @${env.MANAGER_TG_USERNAME}. Без длинных t.me-ссылок — только @username.`;
}

function buildOrlyatnikFactsBlock(
  kb: ReturnType<typeof getKb>,
  elvira: string,
  hasSheetContext: boolean
): string {
  const currentPrice = getTicketPriceToday();
  const header = hasSheetContext
    ? '📋 ДОПОЛНИТЕЛЬНЫЕ ФАКТЫ (если не указано в главном контексте):'
    : '📋 АКТУАЛЬНЫЕ ФАКТЫ (единственный источник правды — только это):';
  return `${header}

📍 Локация и даты:
${kb.LOCATION}
${kb.DATES}
(Есть трансфер из Чебоксар. Точный адрес с геометкой — участникам в закрытый чат после регистрации.)

👥 Масштаб: ${CAMP_SCALE} на одной смене.

💎 Что входит в стоимость (всё включено, строго 21+):
${kb.WHAT_INCLUDED}

💸 Цены и задаток:
${formatOrlyatnikPricingFacts()}
Цена 1-й смены на сегодня по календарю бронирования: ${currentPrice.toLocaleString('ru-RU')} ₽.

Смены: ${kb.AVAILABLE_SHIFTS}. Ближайшие: ${kb.NEXT_SHIFT_TEXT}.

Задаток: ${kb.DEPOSIT} ₽ на Сбер — ${kb.PAYMENT_SBER}
(Задаток всегда ${kb.DEPOSIT} ₽ — не называй другую сумму.)

🎒 Что взять с собой:
${kb.WHAT_TO_TAKE}

Программа подробно — кнопка «Узнать программу» в боте. Условия и инфографика — «Условия и стоимость». Отзывы — кнопка «${(kb as { REVIEWS_BUTTON_LABEL?: string }).REVIEWS_BUTTON_LABEL ?? '💬 Отзывы участников'}» или ${(kb as { REVIEWS_POST_URL?: string }).REVIEWS_POST_URL ?? 'https://t.me/orlyatnik/286'}.

Контакты: организационные и финансовые — Эльвира @${elvira}; сложные и спорные — Кристина @${env.MANAGER_TG_USERNAME}.`;
}

function buildSalesSystem(event: string = 'orlyatnik', opts: SalesSystemOptions = {}): string {
  const kb = getKb(event);
  const elvira = (kb as { MANAGER_ELVIRA_USERNAME?: string }).MANAGER_ELVIRA_USERNAME ?? env.MANAGER_ELVIRA_USERNAME;
  const sheetContext = getLlmContext(kb);
  const primaryBlock = buildPrimaryContextBlock(sheetContext);
  const hasSheetContext = sheetContext.length > 0;
  const confirmedBlock = opts.confirmedParticipant ? buildConfirmedParticipantBlock(event, elvira) : '';
  const strictRules = buildStrictFactsRules(elvira, hasSheetContext);

  if (event === 'pizhamnik') {
    const factsHeader = hasSheetContext ? '📌 Дополнительные факты:' : '📌 Факты (только это):';
    return `Ты — живой организатор выезда «Пижамник» (21–22 марта, дом за городом).
Тон: тёплый, живой, по-человечески. Используй 1–2 уместных эмодзи. Отвечай кратко и по делу.

${primaryBlock ? `${primaryBlock}\n\n` : ''}${factsHeader}
Даты: 21–22 марта. Заезд 21 марта в 14:00, выезд 22 марта в 14:00.
Стоимость: ${kb.PRICE} ₽ (задаток ${kb.DEPOSIT} ₽, остаток ${(kb as { REMAINDER?: number }).REMAINDER ?? 4500} ₽ — не позднее чем за 7 дней до начала).
Мест: ${(kb as { PLACES_LIMIT?: number }).PLACES_LIMIT ?? 21}.
Возврат: ${(kb as { REFUND_DEADLINE_TEXT?: string }).REFUND_DEADLINE_TEXT ?? 'до 14 марта включительно — возврат 4000 ₽.'}

Программа — кнопка «Узнать программу». Условия — «Условия и стоимость».
Бронирование: «🔥 Забронировать место» или «Хочу забронировать».

Возражения:
«Дорого» → «${kb.OBJECTION_PRICE}»
«Один/одна» → «${kb.OBJECTION_SOLO}»
«Не пью» → «${kb.OBJECTION_NO_ALCOHOL}»
«Нет компании» → «${kb.OBJECTION_NO_COMPANY}»

${strictRules}${confirmedBlock}`;
  }

  return `Ты — живой организатор лагеря Орлятник 21+ 🏕
Тон: дружеский, с лёгким юмором, 1–3 уместных эмодзи в ответе. Пиши как человек в чате, не как робот. Учитывай контекст диалога — не повторяйся.

📌 Задачи:
- Отвечай конкретно по фактам ниже: даты, цена, программа, место, что входит, что взять.
- Мягко отрабатывай возражения (только готовые формулировки):
  «Дорого» → «${kb.OBJECTION_PRICE}»
  «Боюсь один/одна» → «${kb.OBJECTION_SOLO}»
  «Не пью / не тусовый» → «${kb.OBJECTION_NO_ALCOHOL}»
  «Нет компании» → «${kb.OBJECTION_NO_COMPANY}»
  «Расскажи с нуля» → яркий рассказ про атмосферу: сап-борды, ночные квесты, Бункер, рейвы, костёр — но без выдуманных деталей программы; подробности — кнопка «Узнать программу».
- К бронированию: «Напиши «Хочу забронировать» или «Готов забронировать»» — только эти фразы запускают анкету в боте.
- После анкеты бот сам даст реквизиты задатка ${kb.DEPOSIT} ₽. После оплаты — чек в бота. Общий чат создаётся позже.

${primaryBlock ? `${primaryBlock}\n\n` : ''}${buildOrlyatnikFactsBlock(kb, elvira, hasSheetContext)}

${strictRules}${confirmedBlock}`;
}

export interface SalesReplyOptions {
  confirmedParticipant?: boolean;
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
  history: ChatTurn[] = [],
  opts: SalesReplyOptions = {}
): Promise<SalesReplyResult> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSalesSystem(event, opts) },
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: 800,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      return {
        text: `Сейчас не могу ответить точно. Напиши, пожалуйста, Эльвире @${env.MANAGER_ELVIRA_USERNAME} (организация/оплата) или Кристине @${env.MANAGER_TG_USERNAME} — подскажут.`,
        ok: false,
      };
    }
    return { text, ok: true };
  } catch (e) {
    logger.error('OpenAI Sales error', { error: String(e) });
    return {
      text: `Сейчас не могу ответить. Напиши Эльвире @${env.MANAGER_ELVIRA_USERNAME} или Кристине @${env.MANAGER_TG_USERNAME} — они на связи.`,
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
  const elvira = (kb as { MANAGER_ELVIRA_USERNAME?: string }).MANAGER_ELVIRA_USERNAME ?? env.MANAGER_ELVIRA_USERNAME;
  const sheetContext = getLlmContext(kb);
  const contextBlock = sheetContext
    ? `\n\nГлавный контекст (приоритет для любых фактов в ответе):\n${sheetContext}\n`
    : '';
  const systemForm = `Ты помогаешь заполнить анкету участника «${eventName}». Стиль: живой, по-человечески, дружелюбно. В reply_text всегда пиши тепло и с 1–2 уместными эмодзи (🎉✨👍😊 и т.п.), без сухих фраз — как организатор в чате.
${contextBlock}
Не придумывай цены, даты и правила — если спрашивают не про анкету, коротко ответь по фактам или направь: организация/оплата — Эльвира @${elvira}, сложное — Кристина @${env.MANAGER_TG_USERNAME}.

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
        reply_text: `Не удалось разобрать ответ. Напиши поле по одному или обратись к Эльвире @${elvira} / Кристине @${env.MANAGER_TG_USERNAME}.`,
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
      reply_text: `Сейчас не могу обработать. Попробуй ещё раз или напиши Эльвире @${elvira}.`,
      form_patch: {},
    };
  }
}
