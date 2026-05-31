/**
 * Динамическая цена путёвки 1 смены (июнь) по календарю бронирования.
 */

const TZ = 'Europe/Moscow';

/** YYYY-MM-DD в Europe/Moscow */
function toMoscowYmd(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export type TicketPrice = 18_000 | 21_000;

/** До 31.05.2026 включительно — 18 000 ₽; с 01.06 по 11.06.2026 — 21 000 ₽; после 11.06 — 21 000 ₽. */
export function getTicketPriceForDate(date: Date = new Date()): TicketPrice {
  const ymd = toMoscowYmd(date);
  if (ymd <= '2026-05-31') return 18_000;
  return 21_000;
}

export function getTicketPriceToday(): TicketPrice {
  return getTicketPriceForDate(new Date());
}

export function formatPriceTierText(): string {
  return (
    '🔥 1 смена (12–14 июня), заезд 12 июня:\n' +
    '• До 20 мая (раннее бронирование) — 16 000 ₽\n' +
    '• До 31 мая — 18 000 ₽\n' +
    '• До 11 июня включительно — 21 000 ₽\n' +
    '☀️ 2 смена (17–19 июля):\n' +
    '• До 20 мая (раннее бронирование) — 16 000 ₽\n' +
    '• После 20 мая — 18 000 ₽\n' +
    '• За 2 недели до смены — 21 000 ₽\n' +
    '🎁 Скидки (не суммируются): вдвоём — 17 000 ₽; компания от 5 — 17 000 ₽; от 10 — 16 000 ₽\n' +
    'Задаток для фиксации места — 8 000 ₽ (всегда 8 000 ₽, без исключений).'
  );
}

export function formatCurrentPriceLine(): string {
  const price = getTicketPriceToday();
  return `Актуальная цена 1-й смены (12–14 июня) на сегодня: ${price.toLocaleString('ru-RU')} ₽. Задаток — 8 000 ₽.`;
}

/** Полный блок цен и скидок для системного промпта LLM (Орлятник). */
export function formatOrlyatnikPricingFacts(): string {
  return `${formatPriceTierText()}\n${formatCurrentPriceLine()}`;
}
