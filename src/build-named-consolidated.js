'use strict';
/**
 * 採用担当者名 判明 × MOCHICAターゲット 企業リスト コンソリデーター
 * =====================================================================
 * 直下に乱立していた「採用担当者名つき」CSVを1本に統合し、同名企業の重複を排除する。
 *   - 採用担当者名が判明している行のみ採用（氏名検証=OK に限定 / ユーザー指定 2026-07）
 *   - 同一企業（法人番号→正規化社名）で名寄せし、複数ソースの項目を補完マージ
 *   - MOCHICAアポ取得期待値を全件で再採点し、◎○△（今週架電/ナーチャリング/後回し）を付与
 *
 * 出力: leads-mochica-named-consolidated.csv（UTF-8 BOM, Excel想定）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, mergeKey, normCompanyName } = require('./csv');
const { scoreMochica, parseEmployees } = require('./mochica-fit');
const { qualifiesForList, proposalTier } = require('./icp-rules');
const { isFullName, isKnownSurname } = require('./jp-names');

const ROOT = path.resolve(__dirname, '..');

// 採用人数（"6～10名"/"6名"/"8" → 6 の下限。不明は null）
const HIRE_COLS = ['採用予定人数', '採用人数', '採用数', '採用予定数'];
function pickHire(rec) { for (const c of HIRE_COLS) { const m = String(rec[c] || '').match(/\d+/); if (m) return parseInt(m[0], 10); } return null; }
// マイナビ採用データでエンリッチした採用人数の上書きマップ（enrich-hire-from-mynavi.js の出力を任意で取り込む）
function loadHireOverride() {
  const p = path.join(ROOT, 'data', 'hire-enriched-mynavi.csv');
  const map = new Map();
  if (!fs.existsSync(p)) return map;
  const { records } = readCsv(fs.readFileSync(p, 'utf8'));
  for (const r of records) {
    const k = normCompanyName(r['企業名'] || ''); if (!k) continue;
    const h = String(r['採用予定人数'] || '').trim(); if (h) map.set(k, { 採用予定人数: h, レンジ: r['採用予定人数レンジ'] || '' });
  }
  return map;
}

// 統合元（採用担当者名あり）。上に置くほど「値の衝突時に優先採用」。
//   電話や規模など裏取り項目が濃いソースを上位に。
const SOURCES = [
  { file: 'leads-mochica-mynavi-callable.csv', tag: 'マイナビ(架電可)' },
  { file: 'leads-mochica-named-callable.csv',  tag: 'named-callable' },
  { file: 'leads-mochica-named-select.csv',    tag: 'named-select' },
  { file: 'leads-recruiter-acquired-1000.csv', tag: 'recruiter取得' },
  { file: 'leads-mochica-mynavi-named.csv',    tag: 'マイナビ(named)' },
  { file: 'leads-mochica-target-namedonly.csv', tag: 'target-namedonly' },
];

// 統合後の出力スキーマ（営業がそのまま使える並び）。採用予定人数・提案プランを追加。
const OUT_HEADERS = [
  '企業名', '採用担当者名', '氏名検証', '役職', '部署',
  '電話番号', 'メール', '従業員数', '採用予定人数', '業種', '提案プラン', '都道府県', '設立年', '法人番号', '新卒フラグ',
  '公式URL', 'アポ期待度', '優先度', 'MOCHICA適合', '確信度', 'なぜ今なぜこの企業',
  '取得元', '根拠URL',
];

const PREF = /^(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)/;
const GEO_TAIL = /(店|支店|営業所|事業所|工場|センター|支社|本社)$/;
function validName(n) {
  const s = String(n || '').trim();
  if (!s) return false;
  const j = s.replace(/[ 　]/g, '');
  if (GEO_TAIL.test(j) || (PREF.test(j) && j.length <= 4)) return false;
  return isFullName(s) || isKnownSurname(s) || /^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(s);
}

// 採用担当者名が判明していて氏名検証OKか（列があればOK限定、無ければvalidNameで判定）
function nameConfirmed(rec) {
  const nm = String(rec['採用担当者名'] || '').trim();
  if (!nm) return false;
  const v = String(rec['氏名検証'] || '').trim();
  if (v) return v === 'OK';
  return validName(nm);
}

const firstNonEmpty = (a, b) => (String(a || '').trim() ? a : b);

function main() {
  const groups = new Map(); // key -> merged raw record + 取得元set
  const srcStats = [];
  let totalIn = 0, kept = 0;

  for (const s of SOURCES) {
    // 取得元CSVは data/ 配下（旧レイアウトの ROOT 直下もフォールバックで許容）
    let p = path.join(ROOT, 'data', s.file);
    if (!fs.existsSync(p)) p = path.join(ROOT, s.file);
    if (!fs.existsSync(p)) { srcStats.push({ file: s.file, n: 0, note: '無し' }); continue; }
    const { records } = readCsv(fs.readFileSync(p, 'utf8'));
    let n = 0;
    for (const r of records) {
      totalIn++;
      if (!nameConfirmed(r)) continue;
      const key = mergeKey(r);
      if (!key) continue;
      n++; kept++;
      const cur = groups.get(key);
      if (!cur) {
        groups.set(key, { rec: { ...r }, srcs: new Set([s.tag]) });
      } else {
        // 補完マージ：既存を優先しつつ、空欄を後続ソースの値で埋める
        for (const [k, v] of Object.entries(r)) cur.rec[k] = firstNonEmpty(cur.rec[k], v);
        cur.srcs.add(s.tag);
      }
    }
    srcStats.push({ file: s.file, n });
  }

  const hireOverride = loadHireOverride();
  const now = new Date();
  const qualified = [];   // 3絶対条件クリア＝呼べる名指しリスト
  const needHire = [];    // 担当者名+電話はあるが採用人数不明＝採用数エンリッチ待ち
  const gateDrop = { 電話なし: 0, IT除外: 0, 採用6名未満: 0, 従業員100名未満: 0 };
  for (const { rec, srcs } of groups.values()) {
    // 採用人数: ソース値 → マイナビエンリッチ上書き の順で補完
    const ov = hireOverride.get(normCompanyName(rec['企業名'] || ''));
    if (ov && !pickHire(rec)) { rec['採用予定人数'] = ov.採用予定人数; rec['採用予定人数レンジ'] = ov.レンジ; }
    const hire = pickHire(rec);
    const emp = parseEmployees(rec['従業員数']);
    const prim = { contactName: rec['採用担当者名'], phone: rec['電話番号'], hire, emp, industry: rec['業種'] };
    const q = qualifiesForList(prim);

    const sc = scoreMochica(rec, { now });
    const tier = proposalTier(emp);
    const row = {
      '企業名': rec['企業名'] || '',
      '採用担当者名': rec['採用担当者名'] || '',
      '氏名検証': String(rec['氏名検証'] || '').trim() || 'OK',
      '役職': rec['役職'] || '',
      '部署': rec['部署'] || '',
      '電話番号': rec['電話番号'] || '',
      'メール': rec['メール'] || '',
      '従業員数': rec['従業員数'] || '',
      '採用予定人数': rec['採用予定人数レンジ'] || rec['採用予定人数'] || rec['採用人数'] || '',
      '業種': rec['業種'] || '',
      '提案プラン': tier.plan,
      '都道府県': rec['都道府県'] || '',
      '設立年': rec['設立年'] || '',
      '法人番号': rec['法人番号'] || '',
      '新卒フラグ': rec['新卒フラグ'] || rec['マイナビ掲載'] || '',
      '公式URL': rec['公式URL'] || '',
      'アポ期待度': sc.total,
      '優先度': sc.priority,
      'MOCHICA適合': sc.total >= 70 ? '◎' : sc.total >= 50 ? '○' : '△',
      '確信度': rec['確信度'] || sc.confidence,
      'なぜ今なぜこの企業': rec['なぜ今なぜこの企業'] || sc.why,
      '取得元': [...srcs].join('/'),
      '根拠URL': rec['根拠URL'] || '',
    };
    if (q.pass) { qualified.push(row); continue; }
    // 採用人数が「不明」だけが理由 → 落とさずエンリッチ待ち行きに退避（ユーザー指定）
    if (q.needHire && q.reasons.length === 1) { needHire.push(row); continue; }
    // それ以外は絶対条件を満たさず除外（内訳を集計）
    if (q.reasons.some((r) => /電話番号なし/.test(r))) gateDrop.電話なし++;
    if (q.reasons.some((r) => /IT/.test(r))) gateDrop.IT除外++;
    if (q.reasons.some((r) => /新卒.*</.test(r))) gateDrop.採用6名未満++;
    if (q.reasons.some((r) => /従業員.*</.test(r))) gateDrop.従業員100名未満++;
  }

  // アポ期待度 降順 → 企業名 で安定ソート
  const sorter = (a, b) => (b['アポ期待度'] - a['アポ期待度']) || a['企業名'].localeCompare(b['企業名'], 'ja');
  qualified.sort(sorter); needHire.sort(sorter);

  const outP = path.join(ROOT, 'leads-mochica-named-consolidated.csv');
  const queueP = path.join(ROOT, 'data', 'leads-mochica-named-need-hire.csv');
  fs.writeFileSync(outP, '﻿' + toCsv(OUT_HEADERS, qualified), 'utf8');
  fs.writeFileSync(queueP, '﻿' + toCsv(OUT_HEADERS, needHire), 'utf8');

  const band = (lo, hi) => qualified.filter((r) => r['アポ期待度'] >= lo && (hi == null || r['アポ期待度'] < hi)).length;
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  採用担当者名 判明 × MOCHICAターゲット 統合リスト（3絶対条件: 担当者名+電話+採用6名）');
  console.log(L);
  console.log('  取得元別（氏名検証OKのみ）:');
  for (const s of srcStats) console.log(`    ${s.file.padEnd(38)} : ${String(s.n).padStart(5)}${s.note ? ' (' + s.note + ')' : ''}`);
  console.log(L);
  console.log(`  投入行(氏名検証OK)          : ${kept}`);
  console.log(`  重複排除後の企業数          : ${qualified.length + needHire.length + Object.values(gateDrop).reduce((a, b) => a + b, 0)}`);
  console.log(`  ── 3絶対条件クリア（呼べる）: ${qualified.length}`);
  console.log(`    ├ ◎ 今週架電(70+)         : ${band(70, null)}`);
  console.log(`    ├ ○ ナーチャ(50-69)       : ${band(50, 70)}`);
  console.log(`    └ △ 後回し(-49)           : ${band(0, 50)}`);
  console.log(`  ── 採用数エンリッチ待ち     : ${needHire.length}  → ${path.relative(ROOT, queueP)}`);
  console.log(`  ── 絶対条件で除外           : ${Object.values(gateDrop).reduce((a, b) => a + b, 0)}  ${JSON.stringify(gateDrop)}`);
  console.log(L);
  console.log(`  呼べるリスト出力: ${outP}`);
  console.log(`  次アクション: node scripts/enrich-hire-from-mynavi.js --in ${path.relative(ROOT, queueP)} --out data/hire-enriched-mynavi.csv`);
  console.log(`               → 再度 node src/build-named-consolidated.js で採用数を反映`);
  console.log('');
}

main();
