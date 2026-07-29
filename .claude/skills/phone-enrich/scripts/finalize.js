'use strict';
// finalize.js <input.csv> <results.json | journal.jsonl> [--seed seed.json]
// Merges workflow phone results into:
//   (a) <base>_phones_filled.csv   — original file + phone column filled (re-importable)
//   (b) <base>_phones_worklist.csv — audit sheet (会社電話/種別/confidence/source/note/status)
// Applies prefix-aware formatting + type labeling. Reports coverage.
const fs = require('fs');
const path = require('path');
const { parseCSV, readFile, esc, findCol, normCompanyName, fmtPhone, phoneType, extractResultsFromJournal } = require('./lib');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; }
const input = process.argv[2], resPath = process.argv[3];
if (!input || !resPath) { console.error('usage: node finalize.js <input.csv> <results.json|journal.jsonl> [--seed seed.json]'); process.exit(1); }

// --- load results (json {results:[]} / array / journal.jsonl) ---
let results;
if (/\.jsonl$/i.test(resPath)) results = extractResultsFromJournal(resPath);
else { const j = JSON.parse(readFile(resPath)); results = j.results || j; }
console.error('results loaded:', results.length);

// --- optional manual seed overrides (json: [{name,phone,confidence,source,note}]) ---
const seed = arg('seed', '');
const seedArr = seed && fs.existsSync(seed) ? JSON.parse(readFile(seed)) : [];

// --- index by normalized name (best phone wins) ---
const byNk = new Map();
const put = (name, phone, confidence, source, note, boost) => {
  if (!name) return; const nk = normCompanyName(name); const ph = fmtPhone(phone);
  const rank = { high: 3, medium: 2, low: 1, none: 0 }[confidence] ?? 0;
  const score = (ph ? 10 : 0) + rank + (boost || 0);
  const cur = byNk.get(nk);
  if (!cur || score > cur.score) byNk.set(nk, { phone: ph, confidence: confidence || '', source: source || '', note: note || '', score });
};
for (const r of results) if (r) put(r.name, r.phone, r.confidence, r.source, r.note, 0);
for (const s of seedArr) put(s.name, s.phone, s.confidence || 'high', s.source, s.note, 100); // seeds win

// --- read input, detect columns ---
const rows = parseCSV(readFile(input));
const H = rows[0];
const nameCol = findCol(H, ['会社情報：会社名', '会社名', '企業名', '取引先名'], ['会社名', '企業名', '取引先']);
let phoneCol = findCol(H, ['会社情報：電話', '電話', '電話番号'], ['電話番号', '電話', 'TEL']);
if (nameCol < 0) { console.error('company-name column not found'); process.exit(1); }
const seiCol = findCol(H, ['担当者情報：姓', '姓'], []); const meiCol = findCol(H, ['担当者情報：名', '名'], []);
const contactCol = findCol(H, ['担当者', '担当者名'], ['担当者']);
const contactOf = (r) => ((seiCol >= 0 ? r[seiCol] : '') || '') + ((meiCol >= 0 ? r[meiCol] : '') || '') || (contactCol >= 0 ? (r[contactCol] || '') : '');

const data = rows.slice(1).filter(r => (r[nameCol] || '').trim());
const base = input.replace(/\.csv$/i, '');

// --- (a) re-importable full CSV: fill the phone column in place (add one if missing) ---
const outHeader = H.slice();
if (phoneCol < 0) { outHeader.push('電話'); phoneCol = outHeader.length - 1; }
const fullLines = [outHeader.map(esc).join(',')];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i].slice(); while (r.length < outHeader.length) r.push('');
  const name = (r[nameCol] || '').trim();
  if (name) { const hit = byNk.get(normCompanyName(name)); if (hit && hit.phone && !(r[phoneCol] || '').trim()) r[phoneCol] = hit.phone; }
  fullLines.push(r.map(esc).join(','));
}
const fullPath = base + '_phones_filled.csv';
fs.writeFileSync(fullPath, '﻿' + fullLines.join('\r\n'), 'utf8');

// --- (b) worklist ---
const wl = ['No', 'ID', '会社名', '担当者', '会社電話', '種別', 'confidence', 'source', 'note', 'status'];
const noCol = findCol(H, ['システム管理情報：No', 'No'], []); const idCol = findCol(H, ['システム管理情報：ID', 'ID'], []);
const wlLines = [wl.map(esc).join(',')];
let filled = 0, none = 0, todo = 0; const typeDist = {}, confDist = {};
for (const r of data) {
  const name = (r[nameCol] || '').trim();
  const hit = byNk.get(normCompanyName(name)) || {};
  const phone = hit.phone || ''; const type = phone ? phoneType(phone) : '';
  const status = phone ? 'done' : (hit.confidence === 'none' ? 'no-phone' : 'todo');
  if (phone) { filled++; typeDist[type] = (typeDist[type] || 0) + 1; confDist[hit.confidence] = (confDist[hit.confidence] || 0) + 1; }
  else if (status === 'no-phone') none++; else todo++;
  wlLines.push([noCol >= 0 ? r[noCol] : '', idCol >= 0 ? r[idCol] : '', name, contactOf(r), phone, type, hit.confidence || '', hit.source || '', hit.note || '', status].map(esc).join(','));
}
const wlPath = base + '_phones_worklist.csv';
fs.writeFileSync(wlPath, '﻿' + wlLines.join('\r\n'), 'utf8');

console.log('=== finalize ===');
console.log('companies:', data.length);
console.log('  電話取得   :', filled, `(${(100 * filled / data.length).toFixed(1)}%)`, JSON.stringify(confDist));
console.log('  公開電話なし:', none);
console.log('  未取得(todo):', todo);
console.log('  種別       :', JSON.stringify(typeDist));
console.log('wrote:\n  ', fullPath, '(re-importable)\n  ', wlPath, '(audit)');
