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
    '• До 31 мая включительно — 18 000 ₽\n' +
    '• С 1 по 11 июня включительно — 21 000 ₽\n' +
    '• Задаток для брони — 8 000 ₽'
  );
}

export function formatCurrentPriceLine(): string {
  const price = getTicketPriceToday();
  return `Сейчас путёвка на 1 смену — ${price.toLocaleString('ru-RU')} ₽ (задаток 8 000 ₽).`;
}
