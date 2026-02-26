/**
 * Парсит CSV с историей чатов (Пользователь: / Бот:), нормализует вопросы,
 * считает частоту и формирует базу ответов для листа «Ответы».
 *
 * Запуск (из корня проекта):
 *   npx ts-node scripts/parse-chat-history.ts "C:\Users\aa\Downloads\чаты  - история (1).csv" "C:\Users\aa\Downloads\чаты  - Лист1.csv"
 *
 * Результат:
 *   - data/answers-seed.csv — для импорта в лист «Ответы» (question_normalized, answer, updated_at)
 *   - data/frequent-questions.md — отчёт по частым вопросам
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(__dirname, '..', 'data');

function normalizeQuestion(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function parseCsvFile(filePath: string): { user: string; bot: string }[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const pairs: { user: string; bot: string }[] = [];
  let i = 0;
  // Пропускаем заголовок
  if (lines[0]?.includes('сообщение') || lines[0]?.includes('Аккаунт')) i = 1;
  while (i < lines.length) {
    const line = lines[i];
    // Начало записи: что-то вроде account,"Пользователь: или ","Пользователь:
    const match = line.match(/^[^"]*"Пользователь:\s*(.*)/);
    if (match) {
      const userParts: string[] = [match[1]];
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('Бот:')) {
        userParts.push(lines[j]);
        j++;
      }
      const userText = userParts.join('\n').trim();
      if (j < lines.length && lines[j].startsWith('Бот:')) {
        const botFirst = lines[j].replace(/^Бот:\s*/, '');
        const botParts: string[] = [botFirst];
        j++;
        while (j < lines.length) {
          const nextLine = lines[j];
          if (/^[^",\n]+,"Пользователь:/.test(nextLine) || (nextLine === '' && j + 1 < lines.length && lines[j + 1]?.match(/^[^",\n]+,"Пользователь:/))) break;
          botParts.push(nextLine);
          j++;
        }
        let botText = botParts.join('\n').trim();
        botText = botText.replace(/"\s*$/, '');
        const userClean = userText.replace(/"\s*$/, '').trim();
        if (userClean && botText) {
          pairs.push({ user: userClean, bot: botText });
        }
        i = j;
        continue;
      }
    }
    i++;
  }
  return pairs;
}

/** Парсинг по блокам: разбиваем по границе следующей записи "\naccount,\"Пользователь:" */
function parseCsvFileByBlocks(filePath: string): { user: string; bot: string }[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const pairs: { user: string; bot: string }[] = [];
  const blockRe = /\n(?:[^",\n]*),"Пользователь:\s*([\s\S]*?)\nБот:([\s\S]*?)"(?=\s*\n(?:[^",\n]*,"Пользователь:)|$)/g;
  let skip = raw.indexOf('Пользователь:');
  if (skip === -1) return pairs;
  let rest = raw.slice(skip);
  let m: RegExpExecArray | null;
  const altRe = /"Пользователь:\s*([\s\S]*?)\nБот:([\s\S]*?)"(?=\s*\n[^",\n]*,"Пользователь:|$)/g;
  while ((m = altRe.exec(rest)) !== null) {
    const user = m[1].replace(/\s+/g, ' ').trim();
    let bot = m[2].trim();
    bot = bot.replace(/\s*\n\s*/g, '\n');
    if (user.length > 0 && user.length < 500 && bot.length > 0 && bot.length < 4000) {
      pairs.push({ user, bot });
    }
  }
  return pairs;
}

function parseFileSmart(filePath: string): { user: string; bot: string }[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const pairs: { user: string; bot: string }[] = [];
  const recordStarts: number[] = [];
  const re = /"Пользователь:\s*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    recordStarts.push(match.index);
  }
  for (let i = 0; i < recordStarts.length; i++) {
    const start = recordStarts[i];
    const end = recordStarts[i + 1] ?? raw.length;
    const block = raw.slice(start, end);
    const botIdx = block.indexOf('\nБот:');
    if (botIdx === -1) continue;
    const userText = block.slice('Пользователь: '.length, botIdx).trim().replace(/\s+/g, ' ');
    let botText = block.slice(botIdx + 6).trim();
    const closeQuote = botText.lastIndexOf('"');
    if (closeQuote >= 0) botText = botText.slice(0, closeQuote);
    botText = botText.replace(/\s*\n\s*/g, '\n').trim();
    if (userText.length > 0 && userText.length < 500 && botText.length > 0 && botText.length < 4000) {
      pairs.push({ user: userText, bot: botText });
    }
  }
  return pairs;
}

function main() {
  const files = process.argv.slice(2).filter((p) => p && fs.existsSync(p));
  if (files.length === 0) {
    console.log('Укажи пути к CSV: npx ts-node scripts/parse-chat-history.ts "путь/к/история.csv" "путь/к/Лист1.csv"');
    process.exit(1);
  }

  const allPairs: { user: string; bot: string }[] = [];
  for (const f of files) {
    const pairs = parseFileSmart(f);
    console.log(`Файл ${path.basename(f)}: ${pairs.length} пар`);
    allPairs.push(...pairs);
  }

  const byNorm = new Map<string, { count: number; answers: string[]; rawQuestions: string[] }>();
  for (const { user, bot } of allPairs) {
    const norm = normalizeQuestion(user);
    if (norm.length < 2) continue;
    if (!byNorm.has(norm)) {
      byNorm.set(norm, { count: 0, answers: [], rawQuestions: [] });
    }
    const entry = byNorm.get(norm)!;
    entry.count++;
    if (!entry.answers.includes(bot)) entry.answers.push(bot);
    if (!entry.rawQuestions.includes(user)) entry.rawQuestions.push(user.slice(0, 80));
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const now = new Date().toISOString();
  const seedRows: string[][] = [['question_normalized', 'answer', 'updated_at']];
  const sorted = [...byNorm.entries()].sort((a, b) => b[1].count - a[1].count);

  for (const [norm, data] of sorted) {
    const bestAnswer = data.answers.reduce((a, b) => (a.length >= b.length ? a : b));
    seedRows.push([norm, bestAnswer.replace(/"/g, '""'), now]);
  }

  const SEP = '\t';
  const seedTsv = seedRows.map((row) => row.join(SEP)).join('\n');
  fs.writeFileSync(path.join(DATA_DIR, 'answers-seed.csv'), '\uFEFF' + seedTsv, 'utf8');
  console.log(`Создан ${path.join(DATA_DIR, 'answers-seed.csv')} (разделитель: табуляция), записей: ${seedRows.length - 1}`);

  let md = '# Частые вопросы (из истории чатов)\n\n';
  md += `Всего уникальных нормализованных вопросов: ${byNorm.size}. Ниже — топ по частоте.\n\n`;
  md += '| № | Вопрос (норм.) | Частота | Примеры формулировок |\n| --- | --- | ---: | --- |\n';
  sorted.slice(0, 80).forEach(([norm, data], i) => {
    const examples = data.rawQuestions.slice(0, 2).join(' | ');
    md += `| ${i + 1} | ${norm.slice(0, 50)}${norm.length > 50 ? '…' : ''} | ${data.count} | ${examples.slice(0, 60)}… |\n`;
  });
  md += '\n## Топ-20 по частоте (вопрос → выбранный ответ)\n\n';
  sorted.slice(0, 20).forEach(([norm, data], i) => {
    const best = data.answers.reduce((a, b) => (a.length >= b.length ? a : b));
    md += `### ${i + 1}. «${norm.slice(0, 60)}» (${data.count} раз)\n\n`;
    md += best.slice(0, 400) + (best.length > 400 ? '…' : '') + '\n\n';
  });
  fs.writeFileSync(path.join(DATA_DIR, 'frequent-questions.md'), md, 'utf8');
  console.log(`Создан ${path.join(DATA_DIR, 'frequent-questions.md')}`);
}

main();
