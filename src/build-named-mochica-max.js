'use strict';
/**
 * build-named-mochica-max
 * =====================================================================
 * 「採用担当者名が判明」×「MOCHICA ICP適合」×「既存リストと非重複」の
 * “到達可能な最大リスト”を1本にまとめる決定版ビルダー。
 *
 * 方針:
 *  1) 採用担当者名カラムを持つ全ハーベスト成果を法人番号/正規化社名でユニオン（best-of統合）
 *  2) 既存リスト（BALESCLOUD/MOCHICA顧客/SF全リード/アプローチ禁止）を社名・法人番号で除外
 *  3) mochica-fit で採点し、IT/ソフト等のハード除外と最下位priorityを落とす
 *  4) アポ期待度降順で出力
 *
 * ネットワーク不要・純ローカル。 node src/build-named-mochica-max.js [--out data/xxx.csv]
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName, normCorpNumber } = require('./csv');
const { scoreMochica } = require('./mochica-fit');
const { buildExclusionIndex } = require('./exclusion-index');

const DATA = path.join(__dirname, '..', 'data');
const args = process.argv.slice(2);
const outArg = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();
const OUT = outArg || path.join(DATA, 'leads-named-mochica-max.csv');

// ── 採用担当者名を持つ全ソース（重複は名寄せで解決） ───────────────
const NAMED_FILES = [
  'leads-mochica-mynavi-named.csv', 'recruiter-mynavi-1000.csv', 'leads-recruiter-acquired-1000.csv',
  'recruiter-wantedly.csv', 'recruiter-fused.csv', 'recruiter-scored-all.csv', 'recruiter-active.csv',
  'leads-prtimes-named-1000.csv', 'recruiter-nonwantedly-mochica.csv', 'recruiter-nonwantedly-clean.csv',
  'recruiter-adaptive.csv', 'recruiter-deep-harvest.csv', 'recruiter-saiyo-tantou.csv', 'recruiter-rep-full.csv',
  'leads-mochica-named-callable.csv', 'leads-mochica-named-select.csv', 'leads-mochica-mynavi-callable.csv',
  'recruiter-gemini.csv', 'recruiter-fresh.csv', 'recruiter-probe-harvest.csv', 'recruiter-recruitpage-full.csv',
];

// 統合レコードに引き継ぐ列（存在すれば best-of で埋める）
const CARRY = [
  '採用担当者名', '役職', '部署', '担当者確度', '氏名検証', '抽出パターン', 'パターン', '担当者根拠',
  '電話番号', 'メール', '公式URL', '採用ページURL', '根拠URL', '根拠',
  '従業員数', '業種', '都道府県', '設立年', '設立', '卒年', '採用予定人数', '募集職種', '新卒フラグ',
  'マイナビ掲載', '法人番号', '取得元', '取得手法', '取得日',
];

function isName(v) { v = (v || '').trim(); return v && v !== '-' && v !== '不明' && v.length >= 2; }
function key(num, co) { return num ? 'C:' + num : (co ? 'N:' + co : null); }

// ── 1) ユニオン ──────────────────────────────────────────────
const merged = new Map();       // key -> record
const nameToKey = new Map();     // N:co -> key（法人番号キーとの相互参照用）
let namedRows = 0;

for (const f of NAMED_FILES) {
  const p = path.join(DATA, f);
  if (!fs.existsSync(p)) continue;
  let recs;
  try { recs = readCsv(fs.readFileSync(p, 'utf8')).records; } catch (e) { console.error('skip', f, e.message); continue; }
  for (const r of recs) {
    const nm = r['採用担当者名'] || r['担当者名'] || '';
    if (!isName(nm)) continue;
    const co = normCompanyName(r['企業名'] || r['company_name'] || '');
    if (!co) continue;
    const num = normCorpNumber(r['法人番号'] || '');
    namedRows++;
    // 既存キー解決（法人番号 or 社名のどちらかで既出なら統合）
    let k = key(num, co);
    if (num && nameToKey.has('N:' + co)) k = nameToKey.get('N:' + co);
    else if (!num && nameToKey.has('N:' + co)) k = nameToKey.get('N:' + co);
    if (!merged.has(k)) {
      merged.set(k, { '企業名': (r['企業名'] || '').trim(), _co: co, _num: num, _src: f });
    }
    const cur = merged.get(k);
    if (num && !cur._num) cur._num = num;
    if (!cur['企業名'] && r['企業名']) cur['企業名'] = r['企業名'].trim();
    for (const col of CARRY) {
      if ((cur[col] == null || String(cur[col]).trim() === '') && r[col] != null && String(r[col]).trim() !== '') {
        cur[col] = r[col];
      }
    }
    nameToKey.set('N:' + co, k);
  }
}
console.log(`ユニオン: ${namedRows}行 → ユニーク社(担当者名あり) ${merged.size}社`);

// ── 2) 既存リスト除外索引 ────────────────────────────────────
// 除外集合の構築は exclusion-index.js に集約（2026-07-30）。以前はこのファイル独自の
// Set(正規化社名/法人番号)で、農協別称・表記ゆれ・納品台帳を突合していなかった。
// MOCHICA顧客 / BALES既存CRM / SF全リード / 納品済み台帳 ＋ アプローチ禁止企業。
const exclude = buildExclusionIndex({ masters: true, ledger: true }).idx;
(() => {
  const p = path.join(DATA, 'アプローチ禁止企業一覧.txt');
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const l of lines) exclude.addName(l, 'アプローチ禁止');
  console.log(`除外源 アプローチ禁止: ${lines.length}社`);
})();

// ── 3) 除外適用 + 採点 ───────────────────────────────────────
const now = new Date('2026-07-11');
let excluded = 0, itDropped = 0, lowDropped = 0;
const scored = [];
for (const [k, rec] of merged) {
  const co = rec._co, num = rec._num;
  if (exclude.has({ 企業名: rec['企業名'] || co, 法人番号: num || '' })) { excluded++; continue; }
  const s = scoreMochica(rec, { now });
  const row = {
    'アポ期待度': s.total,
    '優先度': s.priority,
    '確信度': s.confidence,
    'なぜ今なぜこの企業': s.why || '',
    '企業名': rec['企業名'] || co,
    '採用担当者名': rec['採用担当者名'] || '',
    '役職': rec['役職'] || '',
    '部署': rec['部署'] || '',
    '担当者確度': rec['担当者確度'] || rec['氏名検証'] || '',
    '電話番号': rec['電話番号'] || '',
    'メール': rec['メール'] || '',
    '従業員数': rec['従業員数'] || '',
    '業種': rec['業種'] || '',
    '都道府県': rec['都道府県'] || '',
    '採用予定人数': rec['採用予定人数'] || '',
    '卒年': rec['卒年'] || '',
    '法人番号': num || '',
    '公式URL': rec['公式URL'] || rec['採用ページURL'] || '',
    '根拠URL': rec['根拠URL'] || '',
    '取得元': rec._src,
  };
  // ハード除外(IT/ソフト)は total<=12 で沈むので閾値で落とす
  if (s.total <= 12) { itDropped++; continue; }
  scored.push(row);
}

scored.sort((a, b) => b['アポ期待度'] - a['アポ期待度'] || b['確信度'] - a['確信度']);

const HEADERS = Object.keys(scored[0] || {
  'アポ期待度': '', '優先度': '', '確信度': '', 'なぜ今なぜこの企業': '', '企業名': '', '採用担当者名': '',
  '役職': '', '部署': '', '担当者確度': '', '電話番号': '', 'メール': '', '従業員数': '', '業種': '',
  '都道府県': '', '採用予定人数': '', '卒年': '', '法人番号': '', '公式URL': '', '根拠URL': '', '取得元': '',
});
fs.writeFileSync(OUT, toCsv(HEADERS, scored), 'utf8');

// ── サマリ ───────────────────────────────────────────────────
const byPri = {};
for (const r of scored) byPri[r['優先度']] = (byPri[r['優先度']] || 0) + 1;
const withPhone = scored.filter(r => (r['電話番号'] || '').trim()).length;
console.log('\n──────── 結果 ────────');
console.log(`既存リスト重複で除外 : ${excluded}社`);
console.log(`IT/ソフト等ハード除外: ${itDropped}社`);
console.log(`最終出力            : ${scored.length}社  → ${path.relative(process.cwd(), OUT)}`);
console.log(`  うち電話番号あり  : ${withPhone}社`);
console.log('  優先度分布        :', JSON.stringify(byPri));
