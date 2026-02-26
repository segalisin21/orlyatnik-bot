/**
 * Перезаписывает data/answers-seed.csv с корректным экранированием:
 * поле answer оборачивается в кавычки, внутренние " удваиваются.
 * Так CSV можно импортировать в Google Таблицы без разъезда колонок.
 */
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(__dirname, '..', 'data');
const SEED = path.join(DATA_DIR, 'answers-seed.csv');

function main() {
  const raw = fs.readFileSync(SEED, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return;
  const header = lines[0];
  const out: string[] = [header];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const lastComma = line.lastIndexOf(',');
    if (lastComma === -1) continue;
    const date = line.slice(lastComma + 1).trim();
    const rest = line.slice(0, lastComma);
    const firstComma = rest.indexOf(',');
    if (firstComma === -1) continue;
    const key = rest.slice(0, firstComma).trim();
    const answer = rest.slice(firstComma + 1).trim();
    const quoted = `"${answer.replace(/"/g, '""')}"`;
    out.push([key, quoted, date].join(','));
  }
  fs.writeFileSync(SEED, '\uFEFF' + out.join('\n'), 'utf8');
  console.log('Quoted', out.length - 1, 'rows in', SEED);
}

main();
