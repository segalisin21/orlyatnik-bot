/**
 * Сборка таблицы для рассылки по базе прошлого года.
 *
 * Источники (по приоритету):
 * 1. Google Sheets API — два ID из аргументов или дефолтные legacy-таблицы
 * 2. CSV-выгрузки (чаты + Орлятник)
 * 3. Уже собранный client-base.csv в корне (если API/CSV недоступны)
 *
 * Дополнительно подтягивает chat_id из текущей CRM (GOOGLE_SHEET_ID), если есть credentials.
 *
 * Выход (папка data/):
 *   legacy-broadcast-all.csv      — все контакты, формат листа «Участники»
 *   legacy-broadcast-ready.csv    — только строки с chat_id (можно импортировать / рассылать)
 *   legacy-broadcast-no-id.csv    — только @username, рассылка через бота невозможна
 *
 * Запуск:
 *   npx ts-node scripts/build-legacy-broadcast.ts
 *   npx ts-node scripts/build-legacy-broadcast.ts path/chats.csv path/orlyatnik.csv
 *   npx ts-node scripts/build-legacy-broadcast.ts --sheet-id-chats=XXX --sheet-id-orlyatnik=YYY
 */

import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';

const LEGACY_SHEET_CHATS = '17wecArrdkxgm-QB_bjW3NwmzeXaLDcNuBqgc8c0OnBI';
const LEGACY_SHEET_ORLYATNIK = '1stPv9Yzr7h1OzOoyIYpGzRo7TD6w7FIlu9adzbNfCnQ';

const DEFAULT_CHATY_CSV = path.join(process.env.USERPROFILE ?? '', 'Downloads', 'чаты  - Лист1.csv');
const DEFAULT_ORLYATNIK_CSV = path.join(process.env.USERPROFILE ?? '', 'Downloads', 'Орлятник - Лист4.csv');
const DEFAULT_PARTICIPANTS_CSV = path.join(process.env.USERPROFILE ?? '', 'Downloads', 'Орлятник - Участники.csv');
const CLIENT_BASE_PATH = path.join(process.cwd(), 'client-base.csv');
const OUT_DIR = path.join(process.cwd(), 'data');

const PARTICIPANT_HEADERS = [
  'user_id', 'username', 'chat_id', 'status', 'fio', 'city', 'dob', 'companions',
  'phone', 'comment', 'shift', 'payment_proof_file_id', 'final_sent_at', 'updated_at', 'created_at', 'last_reminder_at',
];

type Category = 'participated' | 'filled_anketa' | 'just_wrote';

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
  user_id?: string;
  chat_id?: string;
}

interface BroadcastRow {
  user_id: string;
  username: string;
  chat_id: string;
  status: string;
  fio: string;
  city: string;
  dob: string;
  companions: string;
  phone: string;
  comment: string;
  shift: string;
  category: Category;
}

function parseArgs(argv: string[]): {
  chatsCsv?: string;
  orlyatnikCsv?: string;
  sheetIdChats?: string;
  sheetIdOrlyatnik?: string;
} {
  const positional: string[] = [];
  let sheetIdChats: string | undefined;
  let sheetIdOrlyatnik: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--sheet-id-chats=')) sheetIdChats = arg.slice('--sheet-id-chats='.length);
    else if (arg.startsWith('--sheet-id-orlyatnik=')) sheetIdOrlyatnik = arg.slice('--sheet-id-orlyatnik='.length);
    else if (!arg.startsWith('--')) positional.push(arg);
  }
  return {
    chatsCsv: positional[0],
    orlyatnikCsv: positional[1],
    sheetIdChats: sheetIdChats ?? LEGACY_SHEET_CHATS,
    sheetIdOrlyatnik: sheetIdOrlyatnik ?? LEGACY_SHEET_ORLYATNIK,
  };
}

function getCredentials(): object | null {
  const json = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (json) {
    try {
      return JSON.parse(json) as object;
    } catch {
      console.error('GOOGLE_SHEETS_CREDENTIALS: invalid JSON');
    }
  }
  const credPath = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH;
  if (credPath && fs.existsSync(credPath)) {
    return JSON.parse(fs.readFileSync(credPath, 'utf8')) as object;
  }
  return null;
}

async function fetchSheetRows(spreadsheetId: string, range = 'A:Z'): Promise<string[][]> {
  const credentials = getCredentials();
  if (!credentials) throw new Error('No Google credentials');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const firstSheet = meta.data.sheets?.[0]?.properties?.title ?? 'Sheet1';
  console.log(`  Sheet "${spreadsheetId.slice(0, 8)}…" → tab "${firstSheet}"`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${firstSheet.replace(/'/g, "''")}'!${range}`,
  });
  const rows = (res.data.values ?? []) as string[][];
  return rows.map((r) => r.map((c) => String(c ?? '').trim()));
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

function readCsvFile(filePath: string): string[][] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lineEnd = raw.includes('\r\n') ? '\r\n' : '\n';
  return raw
    .split(lineEnd)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseCsvRow);
}

/** Парсинг «чаты - Лист1»: колонка account + сообщение в кавычках */
function parseChatyAccounts(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const accounts = new Set<string>();
  let i = 0;
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd >= 0) i = firstLineEnd + 1;
  while (i < raw.length) {
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

function parseChatyFromSheetRows(rows: string[][]): string[] {
  const accounts = new Set<string>();
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  const accIdx = header.findIndex((h) => h.includes('аккаунт') || h === 'account' || h === 'username');
  const start = accIdx >= 0 ? 1 : 0;
  const col = accIdx >= 0 ? accIdx : 0;
  for (const row of rows.slice(start)) {
    const acc = (row[col] ?? '').trim();
    if (acc && !/^\d+$/.test(acc)) accounts.add(acc.replace(/^@/, ''));
  }
  return Array.from(accounts);
}

function looksLikeUsername(s: string): boolean {
  return /^[a-zA-Z0-9_]{3,32}$/.test(s);
}

/** Лист «Участники» прошлого CRM: колонка id = Telegram user_id */
function parseParticipantsIdMap(filePath: string): Map<string, { user_id: string; chat_id: string; username: string }> {
  const rows = readCsvFile(filePath);
  const map = new Map<string, { user_id: string; chat_id: string; username: string }>();
  if (rows.length < 2) return map;

  const header = rows[0].map((h) => h.toLowerCase());
  const accIdx = header.findIndex((h) => h.includes('аккаунт') || h === 'username');
  const idIdx = header.findIndex((h) => h === 'id' || h === 'user_id' || h === 'chat_id');
  const accCol = accIdx >= 0 ? accIdx : 0;
  const idCol = idIdx >= 0 ? idIdx : rows[0].length - 1;

  for (const row of rows.slice(1)) {
    const username = (row[accCol] ?? '').trim().replace(/^@/, '');
    const user_id = (row[idCol] ?? '').trim();
    if (!/^\d{5,}$/.test(user_id)) continue;
    const entry = { user_id, username, chat_id: user_id };
    map.set(`id:${user_id}`, entry);
    if (username) map.set(`u:${username.toLowerCase()}`, entry);
  }
  return map;
}

function parseOrlyatnikRows(rows: string[][]): Map<string, OrlyatnikRow> {
  const byUsername = new Map<string, OrlyatnikRow>();
  const dateLike = /^\d{1,2}\.\d{2}\s+\d{1,2}:\d{2}$/;

  if (rows.length === 0) return byUsername;

  const header = rows[0].map((h) => h.toLowerCase());
  const hasHeader =
    header.some((h) => h.includes('user') || h.includes('username') || h.includes('фио') || h.includes('fio'));

  let userCol = 0;
  let fioCol = 1;
  let cityCol = 2;
  let dobCol = 3;
  let companionsCol = 4;
  let phoneCol = 5;
  let commentCol = 6;
  let shiftCol = 7;
  let userIdCol = -1;
  let chatIdCol = -1;

  if (hasHeader) {
    userCol = header.findIndex((h) => h.includes('username') || h === 'аккаунт' || h === 'login');
    if (userCol < 0) userCol = 0;
    fioCol = header.findIndex((h) => h.includes('фио') || h === 'fio');
    cityCol = header.findIndex((h) => h.includes('город') || h === 'city');
    dobCol = header.findIndex((h) => h.includes('дата') || h === 'dob');
    companionsCol = header.findIndex((h) => h.includes('кем') || h === 'companions');
    phoneCol = header.findIndex((h) => h.includes('тел') || h === 'phone');
    commentCol = header.findIndex((h) => h.includes('аллер') || h.includes('коммент') || h === 'comment');
    shiftCol = header.findIndex((h) => h.includes('смен') || h === 'shift');
    userIdCol = header.findIndex((h) => h === 'user_id' || h === 'userid' || h === 'id');
    chatIdCol = header.findIndex((h) => h === 'chat_id' || h === 'chatid');
    if (fioCol < 0) fioCol = 1;
    if (cityCol < 0) cityCol = 2;
    if (shiftCol < 0) shiftCol = 7;
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;

  for (const row of dataRows) {
    let username = (row[userCol] ?? '').trim().replace(/^@/, '');
    if (!username || dateLike.test(username)) continue;

    let user_id = userIdCol >= 0 ? (row[userIdCol] ?? '').trim() : '';
    let chat_id = chatIdCol >= 0 ? (row[chatIdCol] ?? '').trim() : '';

    if (!looksLikeUsername(username)) {
      if (/^\d{6,}$/.test(username)) {
        user_id = user_id || username;
        chat_id = chat_id || username;
        username = '';
      } else {
        continue;
      }
    }

    const key = username || user_id;
    if (!key) continue;

    const existing = byUsername.get(key);
    const shift = shiftCol >= 0 ? (row[shiftCol] ?? '').trim() : (row[7] ?? '').trim();
    const rec: OrlyatnikRow = {
      username: username || existing?.username || '',
      fio: existing?.fio || (fioCol >= 0 ? row[fioCol] : row[1])?.trim() || '',
      city: (cityCol >= 0 ? row[cityCol] : row[2])?.trim() || '',
      dob: (dobCol >= 0 ? row[dobCol] : row[3])?.trim() || '',
      companions: (companionsCol >= 0 ? row[companionsCol] : row[4])?.trim() || '',
      phone: (phoneCol >= 0 ? row[phoneCol] : row[5])?.trim() || '',
      comment: (commentCol >= 0 ? row[commentCol] : row[6])?.trim() || '',
      shift: existing?.shift || shift,
      note1: (row[8] ?? '').trim(),
      note2: (row[9] ?? '').trim(),
      user_id: user_id || existing?.user_id || '',
      chat_id: chat_id || existing?.chat_id || user_id || existing?.user_id || '',
    };
    if (shift && shift !== 'Не указана') rec.shift = shift;
    byUsername.set(key, rec);
  }
  return byUsername;
}

function categorize(username: string, fromChaty: boolean, orl: OrlyatnikRow | null): Category {
  if (!orl) return 'just_wrote';
  const hasShift = !!(orl.shift && orl.shift !== 'Не указана');
  const hasAnketa = !!(orl.fio?.trim() || orl.city?.trim() || orl.phone?.trim());
  if (hasShift) return 'participated';
  if (hasAnketa) return 'filled_anketa';
  return fromChaty ? 'just_wrote' : 'filled_anketa';
}

function escapeCsv(val: string): string {
  if (val.includes('"') || val.includes(',') || val.includes('\n') || val.includes('\r')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function rowToCsvLine(r: BroadcastRow): string {
  return PARTICIPANT_HEADERS.map((h) => {
    const key = h as keyof BroadcastRow;
    if (key === 'category') return '';
    return escapeCsv(String(r[key as keyof BroadcastRow] ?? ''));
  }).join(',');
}

function loadExistingClientBase(): BroadcastRow[] {
  if (!fs.existsSync(CLIENT_BASE_PATH)) return [];
  const rows = readCsvFile(CLIENT_BASE_PATH);
  if (rows.length < 2) return [];
  const header = rows[0];
  const idx = (name: string) => header.indexOf(name);
  const out: BroadcastRow[] = [];
  for (const cols of rows.slice(1)) {
    const status = cols[idx('status')] ?? '';
    const cat: Category = status.includes('participated')
      ? 'participated'
      : status.includes('filled_anketa')
        ? 'filled_anketa'
        : 'just_wrote';
    out.push({
      user_id: cols[idx('user_id')] ?? '',
      username: cols[idx('username')] ?? '',
      chat_id: cols[idx('chat_id')] ?? '',
      status: status || `LEGACY_${cat}`,
      fio: cols[idx('fio')] ?? '',
      city: cols[idx('city')] ?? '',
      dob: cols[idx('dob')] ?? '',
      companions: cols[idx('companions')] ?? '',
      phone: cols[idx('phone')] ?? '',
      comment: cols[idx('comment')] ?? '',
      shift: cols[idx('shift')] ?? '',
      category: cat,
    });
  }
  return out;
}

async function fetchCrmIdMap(): Promise<Map<string, { user_id: string; chat_id: string; username: string }>> {
  const map = new Map<string, { user_id: string; chat_id: string; username: string }>();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const credentials = getCredentials();
  if (!sheetId || !credentials) return map;

  try {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    for (const tab of ['Участники', 'Пижамник']) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tab}'!A:E`,
      });
      const rows = (res.data.values ?? []) as string[][];
      for (const row of rows.slice(1)) {
        const user_id = String(row[0] ?? '').trim();
        const username = String(row[1] ?? '').trim().replace(/^@/, '');
        const chat_id = String(row[2] ?? '').trim() || user_id;
        if (!user_id && !username) continue;
        const entry = { user_id, chat_id, username };
        if (user_id) map.set(`id:${user_id}`, entry);
        if (username) map.set(`u:${username.toLowerCase()}`, entry);
      }
    }
    console.log(`CRM ${sheetId.slice(0, 8)}…: ${map.size} ключей для обогащения chat_id`);
  } catch (e) {
    console.warn('CRM enrichment skipped:', String(e));
  }
  return map;
}

function enrichFromIdMap(
  rows: BroadcastRow[],
  idMap: Map<string, { user_id: string; chat_id: string; username: string }>,
): void {
  for (const r of rows) {
    if (r.chat_id) continue;
    const byUser = r.username ? idMap.get(`u:${r.username.toLowerCase()}`) : undefined;
    const byId = r.user_id ? idMap.get(`id:${r.user_id}`) : undefined;
    const hit = byUser ?? byId;
    if (!hit?.user_id) continue;
    r.user_id = hit.user_id;
    r.chat_id = hit.chat_id || hit.user_id;
    if (!r.username && hit.username) r.username = hit.username;
  }
}

function mergeRows(primary: BroadcastRow[]): BroadcastRow[] {
  const byKey = new Map<string, BroadcastRow>();
  for (const r of primary) {
    const key = r.user_id || r.username.toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...r });
      continue;
    }
    if (!existing.chat_id && r.chat_id) existing.chat_id = r.chat_id;
    if (!existing.user_id && r.user_id) existing.user_id = r.user_id;
    if (!existing.username && r.username) existing.username = r.username;
    if (!existing.fio && r.fio) existing.fio = r.fio;
    if (!existing.phone && r.phone) existing.phone = r.phone;
    if (existing.category === 'just_wrote' && r.category !== 'just_wrote') {
      existing.category = r.category;
      existing.status = r.status;
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const order: Record<Category, number> = { participated: 0, filled_anketa: 1, just_wrote: 2 };
    return order[a.category] - order[b.category] || a.username.localeCompare(b.username);
  });
}

function writeOutputs(rows: BroadcastRow[]): void {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const allPath = path.join(OUT_DIR, 'legacy-broadcast-all.csv');
  const readyPath = path.join(OUT_DIR, 'legacy-broadcast-ready.csv');
  const noIdPath = path.join(OUT_DIR, 'legacy-broadcast-no-id.csv');

  const header = PARTICIPANT_HEADERS.join(',');
  const allLines = [header, ...rows.map(rowToCsvLine)];
  fs.writeFileSync(allPath, '\uFEFF' + allLines.join('\r\n'), 'utf8');

  const ready = rows.filter((r) => r.chat_id.trim());
  const noId = rows.filter((r) => !r.chat_id.trim() && r.username.trim());

  fs.writeFileSync(readyPath, '\uFEFF' + [header, ...ready.map(rowToCsvLine)].join('\r\n'), 'utf8');
  fs.writeFileSync(
    noIdPath,
    '\uFEFF' + ['username,category,fio,phone,shift', ...noId.map((r) =>
      [escapeCsv(r.username), r.category, escapeCsv(r.fio), escapeCsv(r.phone), escapeCsv(r.shift)].join(','),
    )].join('\r\n'),
    'utf8',
  );

  console.log('\n=== Итог ===');
  console.log('Всего контактов:', rows.length);
  console.log('  participated:', rows.filter((r) => r.category === 'participated').length);
  console.log('  filled_anketa:', rows.filter((r) => r.category === 'filled_anketa').length);
  console.log('  just_wrote:', rows.filter((r) => r.category === 'just_wrote').length);
  console.log('С chat_id (рассылка возможна):', ready.length);
  console.log('Только username (рассылка невозможна):', noId.length);
  console.log('\nФайлы:');
  console.log(' ', allPath);
  console.log(' ', readyPath);
  console.log(' ', noIdPath);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let accountsFromChaty: string[] = [];
  let orlyatnikByUser = new Map<string, OrlyatnikRow>();
  let source = '';

  const chatsCsv = args.chatsCsv ?? DEFAULT_CHATY_CSV;
  const orlyatnikCsv = args.orlyatnikCsv ?? DEFAULT_ORLYATNIK_CSV;

  const credentials = getCredentials();

  if (credentials && args.sheetIdChats && args.sheetIdOrlyatnik) {
    console.log('Читаю legacy Google Sheets через API…');
    try {
      const chatRows = await fetchSheetRows(args.sheetIdChats);
      const orlRows = await fetchSheetRows(args.sheetIdOrlyatnik);
      accountsFromChaty = parseChatyFromSheetRows(chatRows);
      orlyatnikByUser = parseOrlyatnikRows(orlRows);
      source = 'google-sheets-api';
      console.log(`  Чаты: ${accountsFromChaty.length} аккаунтов, Орлятник: ${orlyatnikByUser.size} строк`);
    } catch (e) {
      console.warn('Google Sheets API failed:', String(e));
    }
  }

  if (!source && fs.existsSync(chatsCsv) && fs.existsSync(orlyatnikCsv)) {
    console.log('Читаю CSV:', path.basename(chatsCsv), '+', path.basename(orlyatnikCsv));
    accountsFromChaty = parseChatyAccounts(chatsCsv);
    orlyatnikByUser = parseOrlyatnikRows(readCsvFile(orlyatnikCsv));
    source = 'csv';
    console.log(`  Чаты: ${accountsFromChaty.length}, Орлятник: ${orlyatnikByUser.size}`);
  }

  const legacyIdMap = new Map<string, { user_id: string; chat_id: string; username: string }>();
  if (fs.existsSync(DEFAULT_PARTICIPANTS_CSV)) {
    const fromParticipants = parseParticipantsIdMap(DEFAULT_PARTICIPANTS_CSV);
    for (const [k, v] of fromParticipants) {
      legacyIdMap.set(k, { ...v, chat_id: v.user_id });
    }
    console.log(`Лист «Участники» (legacy): ${Math.floor(fromParticipants.size / 2)} telegram id`);
  }

  let rows: BroadcastRow[] = [];

  if (source) {
    const allUsernames = new Set([...accountsFromChaty, ...orlyatnikByUser.keys()]);
    for (const username of allUsernames) {
      const fromChaty = accountsFromChaty.includes(username);
      const orl = orlyatnikByUser.get(username) ?? null;
      const category = categorize(username, fromChaty, orl);
      const user_id = orl?.user_id ?? '';
      const chat_id = orl?.chat_id || user_id;
      rows.push({
        user_id,
        username,
        chat_id,
        status: `LEGACY_${category}`,
        fio: orl?.fio ?? '',
        city: orl?.city ?? '',
        dob: orl?.dob ?? '',
        companions: orl?.companions ?? '',
        phone: orl?.phone ?? '',
        comment: orl?.comment ?? '',
        shift: orl?.shift ?? '',
        category,
      });
    }
  } else {
    console.log('API/CSV недоступны — использую существующий client-base.csv');
    rows = loadExistingClientBase();
    source = 'client-base.csv';
  }

  enrichFromIdMap(rows, legacyIdMap);

  const crm = await fetchCrmIdMap();
  enrichFromIdMap(rows, crm);

  for (const r of rows) {
    if (r.user_id && !r.chat_id) r.chat_id = r.user_id;
    if (r.chat_id && !r.user_id) r.user_id = r.chat_id;
  }

  rows = mergeRows(rows);
  writeOutputs(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
