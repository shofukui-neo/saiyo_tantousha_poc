'use strict';
/**
 * 既存顧客の類似企業（高ポテンシャル）リスト生成。
 * 実証ICP(empirical-icp-rates.json)の 業種×従業員×採用人数 の実コンバージョン率(lift)を
 * 掛け合わせ、各リードの「成約見込み(propensity)」を推定してランク付けする。
 *   propensity ≈ overall × lift(業種) × lift(規模) × lift(採用人数)   （独立性を仮定した素朴ベイズ）
 * 母集団: SF未コンバートのリードで、業種+従業員+採用人数+電話が揃うもの。
 * 除外: 既存顧客(勝ち済み)/NG(アプローチ禁止)/アーカイブ(死に筋)。
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, normCompanyName } = require('../src/csv');
const { buildNgIndex, ngHit } = require('../src/ng-index');
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const readText = (p) => fs.readFileSync(p, 'utf8');

// ---- 実証レート ----
const rates = JSON.parse(readText(path.join(DATA, 'empirical-icp-rates.json')));
const overall = rates.overall;
const liftMap = (arr) => {
  const m = new Map();
  for (const r of arr) m.set(r.bucket, { lift: r.rate / overall, rate: r.rate, total: r.total });
  return m;
};
const indLift = liftMap(rates.industry);
const empLift = liftMap(rates.emp);
const hireLift = liftMap(rates.hire);

// バンド正規化（empirical-icp.js と同一ロジック）
function empBand(v) {
  if (!v || /不明|^-$/.test(v)) return null;
  const s = v.replace(/,/g, '');
  if (/1～5人|1~5人/.test(s)) return '01:<5';
  if (/5～10|5~10/.test(s)) return '02:5-10';
  if (/10～20|10~20/.test(s)) return '03:10-20';
  if (/20～30|20~30/.test(s)) return '04:20-30';
  if (/30～50|30~50/.test(s)) return '05:30-50';
  if (/50～100|50~100|50人未満/.test(s)) return '06:50-100';
  if (/100～300|100~300|100～200|100～500|100～1千/.test(s)) return '07:100-300';
  if (/300～500|300～1千/.test(s)) return '08:300-500';
  if (/500～1千|500～1000/.test(s)) return '09:500-1000';
  if (/1千～2千|1000～2千|1千人～1万|1千人～5000|1千～1万/.test(s)) return '10:1000-2000';
  if (/2千～5千/.test(s)) return '11:2000-5000';
  if (/5千～1万/.test(s)) return '12:5000-10000';
  if (/1万/.test(s)) return '13:10000+';
  const n = parseInt((s.match(/\d+/) || [])[0] || '', 10);
  if (Number.isFinite(n)) {
    if (n < 5) return '01:<5'; if (n < 10) return '02:5-10'; if (n < 20) return '03:10-20';
    if (n < 30) return '04:20-30'; if (n < 50) return '05:30-50'; if (n < 100) return '06:50-100';
    if (n < 300) return '07:100-300'; if (n < 500) return '08:300-500'; if (n < 1000) return '09:500-1000';
    if (n < 2000) return '10:1000-2000'; if (n < 5000) return '11:2000-5000'; if (n < 10000) return '12:5000-10000';
    return '13:10000+';
  }
  return null;
}
function hireBand(v) {
  if (!v || /不明/.test(v)) return null;
  if (/1～2名|1~2/.test(v)) return '1:1-2';
  if (/3～5名|3~5/.test(v)) return '2:3-5';
  if (/6～10名|6~10/.test(v)) return '3:6-10';
  if (/11～15|11~15/.test(v)) return '4:11-15';
  if (/16～20|16~20/.test(v)) return '5:16-20';
  if (/21～25|26～30|21~25|26~30/.test(v)) return '6:21-30';
  if (/31～35|36～40|41～45|46～50/.test(v)) return '7:31-50';
  if (/51～100/.test(v)) return '8:51-100';
  if (/101～200|201～300|301名/.test(v)) return '9:101+';
  return null;
}

// ---- SF leads ----
const rows = parseCsv(readText(path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv')));
const hIdx = rows.findIndex((r) => r.some((c) => String(c).includes('リードID18')));
const H = rows[hIdx].map((c) => String(c).trim());
const gi = (name) => { let i = H.indexOf(name); if (i >= 0) return i; const w = name.replace(/[（）()]/g, ''); return H.findIndex((h) => h.replace(/[（）()]/g, '') === w); };
const cName = gi('会社名 / 取引先'), cPhone = gi('電話'), cHire = gi('採用人数(選択リスト)'), cStat = gi('リード 状況'), cEmp = gi('従業員数レンジ(ランスケ）'), cInd = gi('業種'), cMail = gi('メール');
const all = rows.slice(hIdx + 1).map((r) => ({
  name: (r[cName] || '').trim(), phone: (r[cPhone] || '').trim(), hire: (r[cHire] || '').trim(),
  status: (r[cStat] || '').trim(), emp: (r[cEmp] || '').trim(), ind: (r[cInd] || '').trim(), mail: (r[cMail] || '').trim(),
})).filter((r) => r.name && !/テスト/.test(r.name));

// 既存顧客(勝ち済み)社名セット = コンバート済み ∪ 顧客リスト
const wonKeys = new Set();
for (const r of all) if (/コンバート/.test(r.status)) { const k = normCompanyName(r.name); if (k) wonKeys.add(k); }
const custRows = parseCsv(readText(path.join(DATA, 'MOCHICAの既存顧客リスト - mochica-companies-list.csv')));
const cHead = custRows[0].map((c) => String(c).trim());
const legalIdx = cHead.indexOf('法人名');
for (const r of custRows.slice(1)) { const nm = (r[legalIdx] || '').trim(); if (nm && nm !== '削除') { const k = normCompanyName(nm); if (k) wonKeys.add(k); } }

// NG索引
const ng = buildNgIndex(readText(path.join(DATA, 'アプローチ禁止企業一覧.txt')));

// ---- スコアリング ----
const EXCLUDE_STATUS = /アーカイブ/; // 死に筋のみ除外
const scored = [];
const dropped = { won: 0, ng: 0, archived: 0, incomplete: 0, dup: 0 };
const seen = new Map();
for (const r of all) {
  if (/コンバート/.test(r.status)) continue; // 未コンバートのみ
  if (EXCLUDE_STATUS.test(r.status)) { dropped.archived++; continue; }
  const eb = empBand(r.emp), hb = hireBand(r.hire), ib = (r.ind || '').trim();
  if (!eb || !hb || !ib || !r.phone) { dropped.incomplete++; continue; }
  const key = normCompanyName(r.name);
  if (!key) continue;
  if (wonKeys.has(key)) { dropped.won++; continue; }
  if (ngHit(r.name, ng)) { dropped.ng++; continue; }

  const li = indLift.get(ib), le = empLift.get(eb), lh = hireLift.get(hb);
  const liftI = li ? li.lift : 1, liftE = le ? le.lift : 1, liftH = lh ? lh.lift : 1;
  let propensity = overall * liftI * liftE * liftH;
  propensity = Math.max(0, Math.min(0.95, propensity));
  const score = Math.round(propensity * 100);
  const conf = (li ? 1 : 0) + (le ? 1 : 0) + (lh ? 1 : 0); // 実測レートで裏打ちされた軸数(0-3)

  const rec = {
    企業名: r.name, 電話: r.phone, メール: r.mail, 業種: ib,
    従業員数レンジ: r.emp, 採用人数: r.hire, リード状況: r.status,
    類似スコア: score, 成約見込み: (propensity * 100).toFixed(1) + '%',
    業種lift: liftI.toFixed(2) + 'x', 規模lift: liftE.toFixed(2) + 'x', 採用lift: liftH.toFixed(2) + 'x',
    確信軸数: conf,
    empBand: eb, hireBand: hb, _key: key,
  };
  // 名寄せ重複は高スコア優先
  if (seen.has(key)) { dropped.dup++; const prev = seen.get(key); if (rec.類似スコア > prev.類似スコア) seen.set(key, rec); continue; }
  seen.set(key, rec);
}
for (const rec of seen.values()) scored.push(rec);
scored.sort((a, b) => b.類似スコア - a.類似スコア || b.確信軸数 - a.確信軸数);

console.log('=== 母集団処理 ===');
console.log('除外:', JSON.stringify(dropped));
console.log('スコア対象(ユニーク社名):', scored.length);

// 「なぜ」列を付与
const bandLabel = { '01:<5': '5名未満', '02:5-10': '5-10名', '03:10-20': '10-20名', '04:20-30': '20-30名', '05:30-50': '30-50名', '06:50-100': '50-100名', '07:100-300': '100-300名', '08:300-500': '300-500名', '09:500-1000': '500-1000名', '10:1000-2000': '1000-2000名', '11:2000-5000': '2000-5000名', '12:5000-10000': '5000-1万名', '13:10000+': '1万名超' };
const hireLabel = { '1:1-2': '1-2名', '2:3-5': '3-5名', '3:6-10': '6-10名', '4:11-15': '11-15名', '5:16-20': '16-20名', '6:21-30': '21-30名', '7:31-50': '31-50名', '8:51-100': '51-100名', '9:101+': '101名+' };
for (const r of scored) {
  r.なぜ類似 = `業種[${r.業種}]${r.業種lift}｜規模[${bandLabel[r.empBand] || ''}]${r.規模lift}｜新卒採用[${hireLabel[r.hireBand] || ''}]${r.採用lift}｜成約見込${r.成約見込み}`;
}

const OUT_COLS = ['企業名', '電話', 'メール', '業種', '従業員数レンジ', '採用人数', 'リード状況', '類似スコア', '成約見込み', '業種lift', '規模lift', '採用lift', '確信軸数', 'なぜ類似'];
function toCsvOut(recs) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [OUT_COLS.join(',')].concat(recs.map((r) => OUT_COLS.map((c) => esc(r[c])).join(','))).join('\n');
}
fs.writeFileSync(path.join(DATA, 'mochica-lookalike-scored.csv'), toCsvOut(scored));
fs.writeFileSync(path.join(DATA, 'mochica-lookalike-top200.csv'), toCsvOut(scored.slice(0, 200)));
console.log('saved: data/mochica-lookalike-scored.csv (' + scored.length + '), data/mochica-lookalike-top200.csv');

// ---- サマリ ----
function distOf(arr, key, top) {
  const m = new Map();
  for (const r of arr) m.set(r[key], (m.get(r[key]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
}
const top200 = scored.slice(0, 200);
console.log('\n=== TOP200 業種構成 ===');
distOf(top200, '業種', 15).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log('\n=== TOP200 規模構成 ===');
distOf(top200.map((r) => ({ b: bandLabel[r.empBand] })), 'b', 15).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log('\n=== TOP200 リード状況 ===');
distOf(top200, 'リード状況', 15).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
console.log('\nスコア分布: >=40:', scored.filter((r) => r.類似スコア >= 40).length, '| >=30:', scored.filter((r) => r.類似スコア >= 30).length, '| >=25:', scored.filter((r) => r.類似スコア >= 25).length);

console.log('\n=== TOP 25 ===');
top200.slice(0, 25).forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. [${r.類似スコア}] ${r.企業名}  | ${r.業種} | ${bandLabel[r.empBand]} | 新卒${hireLabel[r.hireBand]} | ${r.リード状況}`));
