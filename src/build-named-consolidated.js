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
const { buildBalesIndex, suppress } = require('./suppression');
const { isFullName, isKnownSurname } = require('./jp-names');

const ROOT = path.resolve(__dirname, '..');

// サプレッション層（N層）: BALES既存架電CRMの負シグナル索引。純損失架電（既存お断り/商談中への重複）を除外。
function loadBalesIndex() {
  const p = path.join(ROOT, 'data', 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
  if (!fs.existsSync(p)) { console.warn('warn: BALESリスト無し→サプレッション層スキップ'); return new Map(); }
  return buildBalesIndex(fs.readFileSync(p, 'utf8'));
}

// 採用人数（"6～10名"/"6名"/"8" → 6 の下限。不明は null）
const HIRE_COLS = ['採用予定人数', '採用人数', '採用数', '採用予定数'];
function pickHire(rec) { for (const c of HIRE_COLS) { const m = String(rec[c] || '').match(/\d+/); if (m) return parseInt(m[0], 10); } return null; }
// エントリー人数（絶対条件のフロア判定用。未取得は null＝通す / icp-rules.js の passesEntryFloor）
const ENTRY_COLS = ['エントリー数', 'エントリー人数', 'プレエントリー数', '応募者数', '応募数'];
function pickEntry(rec) { for (const c of ENTRY_COLS) { const m = String(rec[c] || '').match(/\d+/); if (m) return parseInt(m[0], 10); } return null; }
// マイナビ採用データでエンリッチした採用人数の上書きマップ。
// enrich-hire-from-mynavi.js の journal（全処理を累積・キー=企業名）を優先的に読む。
// journal は出力CSVと違い「キューから昇格した過去の成功」も保持し続けるため、再統合で取りこぼさない。
function loadHireOverride() {
  const map = new Map();
  const journalP = path.join(ROOT, 'data', 'hire-enriched-mynavi.journal.json');
  if (fs.existsSync(journalP)) {
    try {
      const j = JSON.parse(fs.readFileSync(journalP, 'utf8'));
      for (const [name, v] of Object.entries(j)) {
        const k = normCompanyName(name); const h = String((v && v.採用予定人数) || '').trim();
        if (k && h) map.set(k, { 採用予定人数: h, レンジ: (v && v.レンジ) || '', コース: (v && v.コース) || '' });
      }
    } catch (_) { /* 壊れていたらCSVへフォールバック */ }
  }
  const csvP = path.join(ROOT, 'data', 'hire-enriched-mynavi.csv');
  if (fs.existsSync(csvP)) {
    const { records } = readCsv(fs.readFileSync(csvP, 'utf8'));
    for (const r of records) {
      const k = normCompanyName(r['企業名'] || ''); if (!k || map.has(k)) continue;
      const h = String(r['採用予定人数'] || '').trim(); if (h) map.set(k, { 採用予定人数: h, レンジ: r['採用予定人数レンジ'] || '' });
    }
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

// 統合後の出力スキーマ（営業がそのまま使える並び）。採用予定人数・提案プラン・抑制(N層)を追加。
const OUT_HEADERS = [
  '企業名', '採用担当者名', '氏名検証', '役職', '部署',
  '電話番号', 'メール', '従業員数', '採用予定人数', '業種', '提案プラン', '都道府県', '設立年', '法人番号', '新卒フラグ',
  '公式URL', 'アポ期待度', '優先度', '抑制コード', '抑制理由', 'MOCHICA適合', '確信度', 'なぜ今なぜこの企業',
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
  const balesIdx = loadBalesIndex();
  const now = new Date();
  const nowYm = { y: now.getFullYear(), mo: now.getMonth() + 1 };
  const qualified = [];   // 3絶対条件クリア＋N層通過＝呼べる名指しリスト（降格は末尾に）
  const suppressed = [];  // N層で除外（純損失架電回避）
  const needHire = [];    // 担当者名+電話はあるが採用人数不明＝採用数エンリッチ待ち
  const gateDrop = { 電話なし: 0, IT除外: 0, 採用6名未満: 0, 従業員100名未満: 0 };
  const nStat = { remove: 0, downgrade: 0, keep: 0, codes: {} };
  for (const { rec, srcs } of groups.values()) {
    // 採用人数: ソース値 → マイナビエンリッチ上書き の順で補完
    const ov = hireOverride.get(normCompanyName(rec['企業名'] || ''));
    if (ov && !pickHire(rec)) { rec['採用予定人数'] = ov.採用予定人数; rec['採用予定人数レンジ'] = ov.レンジ; if (ov.コース) rec['募集コース数'] = ov.コース; }
    const hire = pickHire(rec);
    const emp = parseEmployees(rec['従業員数']);
    // company/entry も渡す＝官公庁ブロック・エントリー50名フロア（icp-rules.js のゲート）を効かせる
    const prim = { company: rec['企業名'], contactName: rec['採用担当者名'], phone: rec['電話番号'], hire, emp, entry: pickEntry(rec), industry: rec['業種'] };
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
      '抑制コード': '', '抑制理由': '',
      'MOCHICA適合': sc.total >= 70 ? '◎' : sc.total >= 50 ? '○' : '△',
      '確信度': rec['確信度'] || sc.confidence,
      'なぜ今なぜこの企業': rec['なぜ今なぜこの企業'] || sc.why,
      '取得元': [...srcs].join('/'),
      '根拠URL': rec['根拠URL'] || '',
    };
    // ── 3絶対条件（担当者名+電話+採用6名） ──
    if (!q.pass) {
      // 採用人数が「不明」だけが理由 → 落とさずエンリッチ待ち行きに退避（ユーザー指定）
      if (q.needHire && q.reasons.length === 1) { needHire.push(row); continue; }
      if (q.reasons.some((r) => /電話番号なし/.test(r))) gateDrop.電話なし++;
      if (q.reasons.some((r) => /IT/.test(r))) gateDrop.IT除外++;
      if (q.reasons.some((r) => /新卒.*</.test(r))) gateDrop.採用6名未満++;
      if (q.reasons.some((r) => /従業員.*</.test(r))) gateDrop.従業員100名未満++;
      continue;
    }
    // ── サプレッション層（N層）: 負シグナルで除外/降格 ──
    const n = suppress({ '企業名': row['企業名'], '業種': row['業種'], '採用予定人数': row['採用予定人数'], '募集コース数': rec['募集コース数'] || '' }, balesIdx, { now: nowYm });
    row['抑制コード'] = n.codes.join('/'); row['抑制理由'] = n.reasons.join('｜');
    nStat[n.action]++; for (const c of n.codes) nStat.codes[c] = (nStat.codes[c] || 0) + 1;
    if (n.action === 'remove') { suppressed.push(row); continue; }
    row._down = n.action === 'downgrade' ? 1 : 0; // 降格は末尾へ
    qualified.push(row);
  }

  // 降格を末尾に、その中でアポ期待度 降順 → 企業名 で安定ソート
  const sorter = (a, b) => ((a._down || 0) - (b._down || 0)) || (b['アポ期待度'] - a['アポ期待度']) || a['企業名'].localeCompare(b['企業名'], 'ja');
  const plainSorter = (a, b) => (b['アポ期待度'] - a['アポ期待度']) || a['企業名'].localeCompare(b['企業名'], 'ja');
  qualified.sort(sorter); needHire.sort(plainSorter); suppressed.sort(plainSorter);

  const outP = path.join(ROOT, 'leads-mochica-named-consolidated.csv');
  const queueP = path.join(ROOT, 'data', 'leads-mochica-named-need-hire.csv');
  const supP = path.join(ROOT, 'data', 'leads-mochica-named-suppressed.csv');
  fs.writeFileSync(outP, '﻿' + toCsv(OUT_HEADERS, qualified), 'utf8');
  fs.writeFileSync(queueP, '﻿' + toCsv(OUT_HEADERS, needHire), 'utf8');
  fs.writeFileSync(supP, '﻿' + toCsv(OUT_HEADERS, suppressed), 'utf8');

  const clean = qualified.filter((r) => !r._down);
  const band = (lo, hi) => clean.filter((r) => r['アポ期待度'] >= lo && (hi == null || r['アポ期待度'] < hi)).length;
  const L = '──────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  採用担当者名 判明 × MOCHICAターゲット 統合リスト（3絶対条件 + N層サプレッション）');
  console.log(L);
  console.log('  取得元別（氏名検証OKのみ）:');
  for (const s of srcStats) console.log(`    ${s.file.padEnd(38)} : ${String(s.n).padStart(5)}${s.note ? ' (' + s.note + ')' : ''}`);
  console.log(L);
  console.log(`  投入行(氏名検証OK)          : ${kept}`);
  console.log(`  ── 3絶対条件クリア          : ${qualified.length + suppressed.length}`);
  console.log(`  ── 採用数エンリッチ待ち     : ${needHire.length}  → ${path.relative(ROOT, queueP)}`);
  console.log(`  ── 絶対条件で除外           : ${Object.values(gateDrop).reduce((a, b) => a + b, 0)}  ${JSON.stringify(gateDrop)}`);
  console.log(L);
  console.log(`  【N層サプレッション】BALES照合 ${balesIdx.size}社`);
  console.log(`  ── 除外(純損失架電回避)     : ${suppressed.length}  → ${path.relative(ROOT, supP)}`);
  console.log(`  ── 降格(残すが末尾)         : ${nStat.downgrade}`);
  console.log(`  ── N別内訳                  : ${JSON.stringify(nStat.codes)}`);
  console.log(L);
  console.log(`  ★呼べるリスト(除外後)      : ${qualified.length}（クリーン${clean.length} + 降格${qualified.length - clean.length}）`);
  console.log(`    ├ ◎ 今週架電(70+)         : ${band(70, null)}`);
  console.log(`    ├ ○ ナーチャ(50-69)       : ${band(50, 70)}`);
  console.log(`    └ △ 後回し(-49)           : ${band(0, 50)}`);
  console.log(L);
  console.log(`  呼べるリスト出力: ${outP}`);
  console.log(`  次アクション: node scripts/enrich-hire-from-mynavi.js --in ${path.relative(ROOT, queueP)} --out data/hire-enriched-mynavi.csv → 再統合`);
  console.log('');
}

main();
