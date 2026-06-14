'use strict';
// 既存CSVを「綺麗な1行/セル」CSVへ正規化する。
//  - RFC準拠パーサで引用符内の改行を正しく読み込み
//  - 各セルの改行・タブ・連続空白を単一スペースに畳む（表計算でのセル混入を解消）
//  - BOM+CRLFで書き戻し（Excel日本語対策）
//
//   node src/clean-csv.js leads-daihyou-1000.csv leads-merged-unique.csv leads-1000.csv
const fs = require('fs');
const path = require('path');

function parseCsv(t) {
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); // BOM除去
  const rows = []; let f = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { f.push(cur); cur = ''; } else if (c === '\n') { f.push(cur); rows.push(f); f = []; cur = ''; } else if (c === '\r') { } else cur += c; }
  }
  if (cur !== '' || f.length) { f.push(cur); rows.push(f); }
  return rows;
}
function sanitize(v) {
  return String(v == null ? '' : v).replace(/[\r\n\t\f\v]+/g, ' ').replace(/[ 　]{2,}/g, ' ').trim();
}
function esc(v) { const s = sanitize(v); return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

const files = process.argv.slice(2).filter((a) => a.endsWith('.csv'));
if (!files.length) { console.log('使い方: node src/clean-csv.js <file.csv> ...'); process.exit(1); }

for (const fn of files) {
  if (!fs.existsSync(fn)) { console.log('（無し）', fn); continue; }
  const rows = parseCsv(fs.readFileSync(fn, 'utf8'));
  if (!rows.length) { console.log('（空）', fn); continue; }
  const width = rows[0].length;
  // 列数が一致する行だけ採用（壊れた行は除外）
  const good = rows.filter((r, i) => i === 0 || r.length === width);
  const dropped = rows.length - good.length;
  const out = good.map((r) => r.map(esc).join(',')).join('\r\n');
  fs.writeFileSync(fn, '﻿' + out, 'utf8');
  // 改行を含んでいたセル数を報告
  let multilineCells = 0;
  for (const r of rows.slice(1)) for (const c of r) if (/[\r\n]/.test(c)) multilineCells++;
  console.log('✓', path.basename(fn), `行=${good.length - 1}`, `列=${width}`, `改行畳み=${multilineCells}セル`, dropped ? `除外行=${dropped}` : '');
}
