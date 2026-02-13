/**
 * Сборка базы клиентов из двух CSV прошлого года:
 * - чаты (Лист1): кто писал в бота (аккаунт, переписка)
 * - Орлятник (Лист4): участники с анкетами, сменами, оплатами
 *
 * Выход: один CSV с категориями для рассылок (participated / filled_anketa / just_wrote).
 * Запуск: npx ts-node scripts/build-client-base.ts [путь_чаты.csv] [путь_орлятник.csv]
 * По умолчанию пути — из папки Downloads (подставь свой логин в скрипте или передай аргументами).
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_CHATY =
  path.join(process.env.USERPROFILE ?? '', 'Downloads', 'чаты  - Лист1.csv');
const DEFAULT_ORLYATNIK =
  path.join(process.env.USERPROFILE ?? '', 'Downloads', 'Орлятник - Лист4.csv');
const OUTPUT_PATH = path.join(process.cwd(), 'client-base.csv');

// ——— Парсинг "чаты" (аккаунт, сообщение с переносами в кавычках) ———
function parseChatyCsv(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const accounts = new Set<string>();
  let i = 0;
  // Пропуск заголовка до первой новой строки
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd >= 0) i = firstLineEnd + 1;
  while (i < raw.length) {
    const lineStart = i;
    const commaIdx = raw.indexOf(',', i);
    if (commaIdx < 0) break;
    const account = raw.slice(i, commaIdx).trim();
    i = commaIdx + 1;
    if (raw[i] !== '"') {
      i = raw.indexOf('\n', i) + 1 || raw.length;
      if (account && !account.startsWith('аккаунт')) accounts.add(account);
      continue;
    }
    i += 1;
    const quoteStart = i;
    while (i < raw.length) {
      const nextQuote = raw.indexOf('"', i);
      if (nextQuote < 0) break;
      if (raw[nextQuote + 1] === '"') {
        i = nextQuote + 2;
        continue;
      }
      i = nextQuote + 1;
      if (account && !account.startsWith('аккаунт')) accounts.add(account);
      if (raw[i] === '\r') i += 1;
      if (raw[i] === '\n') i += 1;
      break;
    }
  }
  return Array.from(accounts);
}

function parseCsvRow(line: string): string[] {
  const row: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i += 1;
      let field = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i += 1;
          break;
        }
        field += line[i];
        i += 1;
      }
      row.push(field.trim());
      if (line[i] === ',') i += 1;
    } else {
      const comma = line.indexOf(',', i);
      const end = comma >= 0 ? comma : line.length;
      row.push(line.slice(i, end).trim());
      i = end + (comma >= 0 ? 1 : 0);
    }
  }
  return row;
}

// ——— Парсинг "Орлятник - Лист4" (без заголовка, колонки с запятыми в кавычках) ———
function parseOrlyatnikCsv(filePath: string): Map<string, OrlyatnikRow> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lineEnd = raw.includes('\r\n') ? '\r\n' : raw.includes('\n') ? '\n' : '\r';
  const lines = raw.split(lineEnd).map((s) => s.trim()).filter(Boolean);
  const rows = lines.map(parseCsvRow);
  const byUsername = new Map<string, OrlyatnikRow>();
  const dateLike = /^\d{1,2}\.\d{2}\s+\d{1,2}:\d{2}$/;
  const looksLikeUsername = /^[a-zA-Z0-9_]+$/;
  for (const row of rows) {
    const col0 = (row[0] ?? '').trim();
    if (!col0) continue;
    if (dateLike.test(col0)) continue;
    if (!looksLikeUsername.test(col0)) continue;
    const username = col0;
    const existing = byUsername.get(username);
    const shift = (row[7] ?? '').trim();
    const rec: OrlyatnikRow = {
      username,
      fio: existing?.fio || (row[1] ?? '').trim(),
      city: (row[2] ?? '').trim(),
      dob: (row[3] ?? '').trim(),
      companions: (row[4] ?? '').trim(),
      phone: (row[5] ?? '').trim(),
      comment: (row[6] ?? '').trim(),
      shift: existing?.shift || shift,
      note1: (row[8] ?? '').trim(),
      note2: (row[9] ?? '').trim(),
    };
    if (shift && shift !== 'Не указана') rec.shift = shift;
    byUsername.set(username, rec);
  }
  return byUsername;
}

interface OrlyatnikRow {
  username: string;
  fio: string;
  city: string;
  dob: string;
  companions: string;
  phone: string;
  comment: string;
  shift: string;
  note1: string;
  note2: string;
}

function escapeCsv(val: string): string {
  if (val.includes('"') || val.includes(',') || val.includes('\n') || val.includes('\r')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function main(): void {
  const chatyPath = process.argv[2] || DEFAULT_CHATY;
  const orlyatnikPath = process.argv[3] || DEFAULT_ORLYATNIK;
  if (!fs.existsSync(chatyPath)) {
    console.error('Не найден файл чатов:', chatyPath);
    process.exit(1);
  }
  if (!fs.existsSync(orlyatnikPath)) {
    console.error('Не найден файл Орлятник:', orlyatnikPath);
    process.exit(1);
  }
  const accountsFromChaty = parseChatyCsv(chatyPath);
  const orlyatnikByUser = parseOrlyatnikCsv(orlyatnikPath);
  const allUsernames = new Set([
    ...accountsFromChaty,
    ...orlyatnikByUser.keys(),
  ]);
  type Category = 'participated' | 'filled_anketa' | 'just_wrote';
  const rows: { username: string; category: Category; row: OrlyatnikRow | null }[] = [];
  for (const username of allUsernames) {
    const fromChaty = accountsFromChaty.includes(username);
    const orl = orlyatnikByUser.get(username) ?? null;
    let category: Category = 'just_wrote';
    if (orl) {
      const hasShift = orl.shift && orl.shift !== 'Не указана';
      const hasAnketa = !!(orl.fio?.trim() || orl.city?.trim() || orl.phone?.trim());
      if (hasShift) category = 'participated';
      else if (hasAnketa) category = 'filled_anketa';
      else if (fromChaty) category = 'just_wrote';
    }
    rows.push({ username, category, row: orl });
  }
  rows.sort((a, b) => {
    const order: Record<Category, number> = {
      participated: 0,
      filled_anketa: 1,
      just_wrote: 2,
    };
    return order[a.category] - order[b.category] || a.username.localeCompare(b.username);
  });
  const header =
    'username,category,fio,city,dob,companions,phone,shift,comment,note1,note2,source_chaty,source_orlyatnik';
  const lines = [header];
  for (const { username, category, row } of rows) {
    const r = row ?? ({} as OrlyatnikRow);
    lines.push(
      [
        escapeCsv(username),
        category,
        escapeCsv(r.fio ?? ''),
        escapeCsv(r.city ?? ''),
        escapeCsv(r.dob ?? ''),
        escapeCsv(r.companions ?? ''),
        escapeCsv(r.phone ?? ''),
        escapeCsv(r.shift ?? ''),
        escapeCsv(r.comment ?? ''),
        escapeCsv(r.note1 ?? ''),
        escapeCsv(r.note2 ?? ''),
        accountsFromChaty.includes(username) ? '1' : '0',
        row ? '1' : '0',
      ].join(',')
    );
  }
  fs.writeFileSync(OUTPUT_PATH, '\uFEFF' + lines.join('\r\n'), 'utf8');
  console.log('Готово:', OUTPUT_PATH);
  console.log('Всего записей:', rows.length);
  console.log(
    'По категориям:',
    'participated:', rows.filter((r) => r.category === 'participated').length,
    ', filled_anketa:', rows.filter((r) => r.category === 'filled_anketa').length,
    ', just_wrote:', rows.filter((r) => r.category === 'just_wrote').length
  );
}

main();
