#!/usr/bin/env node
/**
 * Analyze JSON log file (e.g. Railway/deploy logs).
 * Usage: node scripts/analyze-logs.js <path-to-logs.json>
 */

const fs = require('fs');
const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/analyze-logs.js <path-to-logs.json>');
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(path, 'utf8');
} catch (e) {
  console.error('Read error:', e.message);
  process.exit(1);
}

let arr;
try {
  arr = JSON.parse(raw);
} catch (e) {
  console.error('Parse error:', e.message);
  process.exit(1);
}

console.log('Total entries:', arr.length);

const bySeverity = {};
arr.forEach((e) => {
  const s = e.severity || '?';
  bySeverity[s] = (bySeverity[s] || 0) + 1;
});
console.log('By severity:', JSON.stringify(bySeverity, null, 2));

const errors = arr.filter(
  (e) =>
    e.severity === 'error' ||
    (e.message && /error|failed|Error|Failed|exception/i.test(e.message))
);
console.log('\nEntries with error/failed:', errors.length);
errors.slice(0, 20).forEach((e) => {
  console.log(' ', (e.timestamp || '').slice(0, 28), (e.message || '').slice(0, 100));
});

const uniqMessages = [...new Set(arr.map((e) => (e.message || '').slice(0, 150)))].filter(Boolean);
console.log('\nUnique message prefixes (first 30):');
uniqMessages.slice(0, 30).forEach((m) => console.log(' -', m));
