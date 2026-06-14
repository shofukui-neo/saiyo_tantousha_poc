'use strict';
// 複数の1000件CSVを名寄せ統合して一意リストにする。
//  - 優先順: 先に渡したCSVを base（リッチな代表者名つきgBizを先頭に）
//  - dedup キー: 企業名コア（companyCore）。両方に法人番号があり不一致なら別企業として温存
//  - マージ規則: base が空の列だけ後続ソースの値で補完（電話・URL等の取りこぼし回収）
//
//   node src/merge-lists.js --out leads-merged-unique.csv leads-daihyou-1000.csv leads-1000.csv
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { companyCore } = require('./search');
const { writeMasterCsv } = require('./master-io');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const OUT = getArg('out', 'leads-merged-unique.csv');
const files = process.argv.slice(2).filter((a) => a.endsWith('.csv') && a !== OUT);

// RFC風CSVパーサ
function parseCsv(t) {
  const rows = []; let f = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { f.push(cur); cur = ''; } else if (c === '\n') { f.push(cur); rows.push(f); f = []; cur = ''; } else if (c === '\r') { } else cur += c; }
  }
  if (cur || f.length) { f.push(cur); rows.push(f); }
  return rows;
}
function readRecords(fn) {
  const rows = parseCsv(fs.readFileSync(fn, 'utf8'));
  if (!rows.length) return [];
  const H = rows[0];
  return rows.slice(1).filter((r) => r.length === H.length && r.some((x) => x.trim()))
    .map((r) => { const o = {}; H.forEach((h, i) => { o[h] = r[i]; }); return o; });
}

const order = [];
const byKey = new Map();
let stats = {};

function keyOf(rec) {
  const core = companyCore(rec['企業名'] || '').toLowerCase();
  return core || ('row:' + Math.random());
}

for (const fn of files) {
  let recs = [];
  try { recs = readRecords(fn); } catch (e) { console.log('読込失敗', fn, e.message); continue; }
  stats[fn] = recs.length;
  for (const rec of recs) {
    const k = keyOf(rec);
    const corp = String(rec['法人番号'] || '').trim();
    if (byKey.has(k)) {
      const base = byKey.get(k);
      const baseCorp = String(base['法人番号'] || '').trim();
      // 両方に法人番号があり不一致＝同名異企業 → 別キーで温存
      if (corp && baseCorp && corp !== baseCorp) {
        const k2 = k + '|' + corp;
        if (!byKey.has(k2)) { byKey.set(k2, Object.assign({}, rec)); order.push(k2); }
        continue;
      }
      // base の空欄だけ補完
      for (const h of cfg.MASTER_HEADERS) {
        if ((!base[h] || !String(base[h]).trim()) && rec[h] && String(rec[h]).trim()) base[h] = rec[h];
      }
    } else {
      byKey.set(k, Object.assign({}, rec));
      order.push(k);
    }
  }
}

const merged = order.map((k) => byKey.get(k));
writeMasterCsv(OUT, merged, cfg.MASTER_HEADERS);
fs.mkdirSync(path.resolve(__dirname, '..', 'data'), { recursive: true });
fs.writeFileSync(path.resolve(__dirname, '..', 'data', 'merged-records.json'), JSON.stringify(merged));

const cov = (f) => merged.filter((r) => String(r[f] || '').trim()).length;
console.log('入力:', JSON.stringify(stats));
console.log('統合後ユニーク:', merged.length, '件');
console.log('  法人番号', cov('法人番号'), '/ 代表者名', cov('代表者名'), '/ 電話番号', cov('電話番号'), '/ 公式URL', cov('公式URL'), '/ メール', cov('メール'));
console.log('出力:', path.resolve(OUT));
