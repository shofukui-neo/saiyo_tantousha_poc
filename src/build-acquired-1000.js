'use strict';
/**
 * 採用担当者名 取得リスト 1000件 コンソリデーター
 * =====================================================================
 * 全ての「採用担当者名つき」取得結果を1本に統合し、重複排除して 1000件 の取得リストを確定する。
 * さらに MOCHICAターゲット適合（mochica-fit）と取得元・氏名検証を付与して、営業がそのまま使える形にする。
 *
 *   取得ソース（採用担当者名あり）:
 *     企業サイト探索系（高=MOCHICA新卒に直結）:
 *       data/recruiter-adaptive.csv      適応型 全ページ探索（自己強化）★本命の増加分
 *       data/recruiter-deep-harvest.csv  深掘りプローバ
 *       data/recruiter-probe-harvest.csv / -fresh / -gemini / -recruitpage-full
 *       data/recruiter-mynavi.csv        マイナビ（氏名は稀／掲載・電話の補強）
 *     discovery-first系（量を担保）:
 *       data/recruiter-wantedly.csv      Wantedly投稿者（中途寄り・1000件）
 *     leads-mochica-target.csv の担当者名あり行
 *
 *   node src/build-acquired-1000.js [--target 1000]
 *   出力: leads-recruiter-acquired-1000.csv（取得リスト）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey, normCompanyName, normCorpNumber, truthy } = require('./csv');
const { scoreMochica } = require('./mochica-fit');
const { isFullName, isKnownSurname } = require('./jp-names');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const TARGET = parseInt(getArg('target', '1000'), 10);

// ソース定義（上ほど優先＝企業サイト探索系を上位に。tierは取得手法の質）
const SOURCES = [
  { p: 'recruiter-adaptive.csv', tag: '企業サイト探索(適応)', tier: '企業サイト', kind: 'recruit-page' },
  { p: 'recruiter-deep-harvest.csv', tag: '企業サイト探索(深掘り)', tier: '企業サイト', kind: 'recruit-page' },
  { p: 'recruiter-probe-harvest.csv', tag: '企業サイト探索', tier: '企業サイト', kind: 'recruit-page' },
  { p: 'recruiter-fresh.csv', tag: '自社採用ページ', tier: '企業サイト', kind: 'recruit-page' },
  { p: 'recruiter-gemini.csv', tag: '自社採用ページ', tier: '企業サイト', kind: 'recruit-page' },
  { p: 'recruiter-recruitpage-full.csv', tag: '自社採用ページ', tier: '企業サイト', kind: 'recruit-page' },
  { p: 'recruiter-mynavi.csv', tag: 'マイナビ', tier: '媒体', kind: 'mynavi' },
  { p: 'recruiter-wantedly.csv', tag: 'Wantedly', tier: 'discovery', kind: 'wantedly' },
];
const BORROW = ['電話番号', '従業員数', '設立年', '業種', '都道府県', '代表者名', '法人番号', '公式URL', 'メール',
  'マイナビ掲載', '新卒フラグ', '新卒出稿', '現在求人掲載中', '掲載媒体', '掲載媒体数', '採用中', '求人件数',
  '採用予定人数', '募集職種数', '採用職種', '職種', '採用ページ有無', '採用ページURL', '新卒言及', '辞退シグナル'];

const loadCsv = (p) => fs.existsSync(p) ? readCsv(fs.readFileSync(p, 'utf8')).records : [];
const loadJson = (p) => { if (!fs.existsSync(p)) return []; try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : (j.records || []); } catch { return []; } };

const GEO_TAIL = /[都道府県市区町村郡]$/;
const PREF = /^(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)/;
function validName(n) { const s = String(n || '').trim(); if (!s) return false; const j = s.replace(/[ 　]/g, ''); if (GEO_TAIL.test(j) || (PREF.test(j) && j.length <= 4)) return false; return isFullName(s) || isKnownSurname(s) || /^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(s); }

function buildAttrIndex() {
  const idx = new Map();
  const absorb = (recs) => { for (const r of recs) { const num = normCorpNumber(r['法人番号']); const nm = normCompanyName(r['企業名'] || r['company_name'] || ''); const keys = []; if (num) keys.push('C:' + num); if (nm) keys.push('N:' + nm); if (!keys.length) continue; let cur = null; for (const k of keys) if (idx.has(k)) { cur = idx.get(k); break; } if (!cur) cur = {}; for (const col of BORROW) if ((cur[col] == null || cur[col] === '') && r[col] != null && String(r[col]).trim() !== '') cur[col] = r[col]; for (const k of keys) idx.set(k, cur); } };
  absorb(loadCsv(path.join(ROOT, 'leads-mochica-target.csv')));
  absorb(loadCsv(path.join(DATA, 'recruiter-mynavi.csv')));
  for (const f of ['merged-records.json', 'fresh-records.json', 'records-1000.json', 'gbiz-records.json']) absorb(loadJson(path.join(DATA, f)));
  return idx;
}
function attrLookup(idx, rec) { const num = normCorpNumber(rec['法人番号']); if (num && idx.has('C:' + num)) return idx.get('C:' + num); const nm = normCompanyName(rec['企業名'] || ''); return nm ? idx.get('N:' + nm) : null; }

function main() {
  const byKey = new Map();
  const srcStats = [];
  for (const s of SOURCES) {
    const recs = loadCsv(path.join(DATA, s.p)).filter((r) => String(r['採用担当者名'] || '').trim());
    srcStats.push({ src: s.p, n: recs.length });
    for (const r of recs) {
      const k = mergeKey(r); if (!k) continue;
      if (byKey.has(k)) continue;                       // 先勝ち（SOURCES順＝企業サイト探索系を優先採用）
      const evid = r['根拠URL'] || '';
      const cand = { '企業名': r['企業名'], '採用担当者名': r['採用担当者名'], '役職': r['役職'] || '', '部署': r['部署'] || '', '取得元': r['取得元'] || s.tag, '取得手法': s.tier, '確度': r['確度'] || '', '根拠URL': evid, '根拠': r['根拠'] || '', '公式URL': r['公式URL'] || '', '_kind': s.kind };
      if (s.kind === 'recruit-page') { cand['採用ページ有無'] = '○'; if (evid) cand['採用ページURL'] = evid; }
      if (s.kind === 'mynavi') cand['マイナビ掲載'] = r['マイナビ掲載'] || '○';
      byKey.set(k, cand);
    }
  }

  const attr = buildAttrIndex();
  const now = new Date();
  const recs = [];
  for (const [, rec] of byKey) { const a = attrLookup(attr, rec); if (a) for (const c of BORROW) if (a[c] != null && a[c] !== '' && !String(rec[c] || '').trim()) rec[c] = a[c]; recs.push(rec); }

  // 採点＋氏名検証。並べ替え: 企業サイト探索系を上位 → アポ期待度 → 確度。
  const tierRank = { '企業サイト': 0, '媒体': 1, 'discovery': 2 };
  const scored = recs.map((rec) => ({ rec, s: scoreMochica(rec, { now }), valid: validName(rec['採用担当者名']) }));
  scored.sort((a, b) => (tierRank[a.rec['取得手法']] - tierRank[b.rec['取得手法']]) || (b.s.total - a.s.total));

  const headers = ['順位', '取得手法', '採用担当者名', '氏名検証', '企業名', '役職', '部署', '取得元', 'アポ期待度', '優先度', 'MOCHICA適合', '電話番号', '従業員数', '業種', '都道府県', '新卒フラグ', '法人番号', '公式URL', '根拠URL'];
  const rows = scored.slice(0, TARGET).map((x, i) => ({ '順位': i + 1, '取得手法': x.rec['取得手法'], '採用担当者名': x.rec['採用担当者名'], '氏名検証': x.valid ? 'OK' : '要確認', '企業名': x.rec['企業名'], '役職': x.rec['役職'], '部署': x.rec['部署'], '取得元': x.rec['取得元'], 'アポ期待度': x.s.total, '優先度': x.s.priority, 'MOCHICA適合': x.s.total >= 70 ? '◎' : x.s.total >= 50 ? '○' : '△', '電話番号': x.rec['電話番号'] || '', '従業員数': x.rec['従業員数'] || '', '業種': x.rec['業種'] || '', '都道府県': x.rec['都道府県'] || '', '新卒フラグ': x.rec['新卒フラグ'] || '', '法人番号': x.rec['法人番号'] || '', '公式URL': x.rec['公式URL'] || '', '根拠URL': x.rec['根拠URL'] || '' }));
  const outP = path.join(ROOT, 'leads-recruiter-acquired-1000.csv');
  fs.writeFileSync(outP, toCsv(headers, rows), 'utf8');

  const L = '──────────────────────────────────────────────';
  const byTier = (t) => scored.filter((x) => x.rec['取得手法'] === t).length;
  const mochicaFit = scored.filter((x) => x.s.total >= 70 && x.valid).length;
  console.log('\n' + L);
  console.log('  採用担当者名 取得リスト コンソリデーション');
  console.log(L);
  console.log('  取得ソース（採用担当者名あり）:');
  for (const s of srcStats) console.log(`    ${s.src.padEnd(34)} : ${s.n}`);
  console.log(L);
  console.log(`  重複排除後の総取得数 : ${recs.length}社`);
  console.log(`    ├ 企業サイト探索系 : ${byTier('企業サイト')}（MOCHICA新卒に直結）`);
  console.log(`    ├ 媒体(マイナビ)   : ${byTier('媒体')}`);
  console.log(`    └ discovery(Wantedly): ${byTier('discovery')}`);
  console.log(`  氏名検証OK           : ${scored.filter((x) => x.valid).length}社`);
  console.log(`  MOCHICA高適合(70+×検証OK): ${mochicaFit}社`);
  console.log(L);
  console.log(`  出力: ${outP}（上位 ${rows.length}件）`);
  console.log(`  ${recs.length >= TARGET ? '✅ 目標 ' + TARGET + '件 達成' : '⏳ 現在 ' + recs.length + '件（適応クロール継続で増加中）'}\n`);
}

main();
