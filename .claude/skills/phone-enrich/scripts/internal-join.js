'use strict';
// internal-join.js <input.csv> --sources f1.csv,f2.csv,... [--out worklist.csv]
// STEP 1 (free, no web): fill phones by matching company names against internal
// phone-bearing CSVs (Salesforce export, 架電リスト, callable lists). Reports coverage
// and writes a worklist marking done / todo. Always run this BEFORE the web workflow.
const path = require('path');
const { parseCSV, readFile, writeCSV, findCol, normCompanyName, goodPhone } = require('./lib');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; }
const input = process.argv[2];
if (!input || input.startsWith('--')) { console.error('usage: node internal-join.js <input.csv> --sources f1,f2 [--out worklist.csv]'); process.exit(1); }
const sources = (arg('sources', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const out = arg('out', input.replace(/\.csv$/i, '') + '_internal_worklist.csv');
if (!sources.length) { console.error('provide --sources (comma-separated CSV paths that contain company name + phone)'); process.exit(1); }

const NAME_KEYS = { exact: ['会社名', '企業名', '取引先名', '会社名 / 取引先', '会社名/取引先', '会社情報：会社名'], contains: ['会社名', '企業名', '取引先'] };
const TEL_KEYS = { exact: ['電話', '電話番号', 'TEL', '担当者電話', '会社情報：電話'], contains: ['電話', 'TEL'] };

const index = new Map();
for (const f of sources) {
  let rows; try { rows = parseCSV(readFile(f)); } catch (e) { console.error('skip (unreadable):', f); continue; }
  // header row may not be line 0 (SF export has title rows) — find the row that has both a name and a phone col
  let hi = rows.findIndex(r => findCol(r, NAME_KEYS.exact, NAME_KEYS.contains) >= 0 && findCol(r, TEL_KEYS.exact, TEL_KEYS.contains) >= 0);
  if (hi < 0) hi = 0;
  const H = rows[hi];
  const ni = findCol(H, NAME_KEYS.exact, NAME_KEYS.contains);
  const ti = findCol(H, TEL_KEYS.exact, TEL_KEYS.contains);
  if (ni < 0 || ti < 0) { console.error('no name/phone cols in', path.basename(f)); continue; }
  let n = 0;
  for (let i = hi + 1; i < rows.length; i++) {
    const nm = (rows[i][ni] || '').trim(); if (!nm || /テスト|test/i.test(nm)) continue;
    const ph = goodPhone(rows[i][ti]); if (!ph) continue;
    const k = normCompanyName(nm); if (!index.has(k)) { index.set(k, { phone: ph, source: path.basename(f) }); n++; }
  }
  console.error('indexed', n, 'from', path.basename(f));
}
console.error('unique names indexed:', index.size);

const rows = parseCSV(readFile(input));
const H = rows[0];
const ci = { name: findCol(H, ['会社情報：会社名', '会社名', '企業名'], ['会社名', '企業名']), sei: findCol(H, ['担当者情報：姓', '姓'], []), mei: findCol(H, ['担当者情報：名', '名'], []) };
const data = rows.slice(1).filter(r => (r[ci.name] || '').trim());
let done = 0;
const wl = data.map(r => {
  const name = (r[ci.name] || '').trim();
  const hit = index.get(normCompanyName(name));
  if (hit) done++;
  return [name, ((ci.sei >= 0 ? r[ci.sei] : '') || '') + ((ci.mei >= 0 ? r[ci.mei] : '') || ''),
    hit ? hit.phone : '', hit ? hit.source : '', hit ? 'done' : 'todo'];
});
writeCSV(out, ['会社名', '担当者', '会社電話', 'source', 'status'], wl);
console.log('\n=== internal-join ===');
console.log('companies:', data.length, '| matched:', done, `(${(100 * done / data.length).toFixed(1)}%) | remaining:`, data.length - done);
console.log('worklist:', out, '\n=> run the web workflow (gen-workflow.js) for the "todo" rows.');
