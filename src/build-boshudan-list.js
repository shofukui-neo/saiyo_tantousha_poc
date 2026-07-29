'use strict';
/**
 * build-boshudan-list — 新卒「母集団課題」ニーズ特化 BALESリスト ビルダー
 * =====================================================================
 * BALESCLOUD の既存リード（22,892件・過去架電/商談ヒアリング履歴つき）から
 * 「**新卒の母集団形成に課題がある**」と自ら語ったリードだけを抜き出し、
 * 架電不能・アプローチ不可・ICP不適合を落として、
 * **BALESCLOUD 取込構造（266列）そのまま**の再アプローチ用リストを生成する。
 *
 * ■ なぜ既存BALESリードなのか
 *   「母集団が集まらない」という“生の声”は自由記述履歴にしか無く、それを持つのは
 *   BALESのみ（SFのMOCHICA参照エクスポートは自由記述列を持たない）。
 *   ＝ ニーズが実データで裏取りできる唯一の母集団。（cf. [[kento-jiki-bales-only]]）
 *   新規発掘リスト（npm run new-list）とは層が違う「温かい再アプローチ」層。
 *
 * ■ パイプライン
 *   1) ニーズ判定 : src/boshudan-needs.js（強／中。充足・テンプレ・中途はガードで除外）
 *   2) 除外       : アプローチ禁止／架電拒否／新卒なし・担当外／1~2名採用／既存顧客(MOCHICA)
 *                   ／電話なし／商談コンバート済／IT業種／従業員<100(判明時のみ)
 *   3) 名寄せ     : company-match で1社1行（強度→スコア→新しさ で最良リードを残す）
 *   4) 採点       : ニーズ強度＋到達性＋ICP適合＋検討時期 で 0-100 → 優先度A/B/C
 *   5) 出力       : ①BALES 266列（取込用・原本の値そのまま） ②根拠つきレビューCSV
 *
 * 使い方:
 *   node src/build-boshudan-list.js
 *   node src/build-boshudan-list.js --level 強          # 強シグナルだけに絞る
 *   node src/build-boshudan-list.js --min-score 60      # スコア下限
 *   node src/build-boshudan-list.js --keep-it           # IT業種を落とさない
 *   node src/build-boshudan-list.js --dedupe-history    # 納品台帳の過去作成企業も除外
 *   node src/build-boshudan-list.js --out data/xxx.csv --review data/yyy.csv
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToRecords, toCsv, readCsv, normCompanyName } = require('./csv');
const { detectBoshudanNeeds } = require('./boshudan-needs');
const { classifyRefusal } = require('./talk-analysis');
const { createMatchIndex } = require('./company-match');
const { loadLedger, DEFAULT_LEDGER } = require('./delivered-ledger');
const { isExcludedIndustry, ICP } = require('./icp-rules');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (k) => args.includes(k);

const BALES = path.resolve(getArg('--bales', path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv')));
const CUSTOMERS = path.resolve(getArg('--customers', path.join(DATA, 'MOCHICAの既存顧客リスト - mochica-companies-list.csv')));
const OUT = path.resolve(getArg('--out', path.join(DATA, 'leads-bales-boshudan.csv')));
const REVIEW = path.resolve(getArg('--review', path.join(DATA, 'bales-母集団課題-根拠.csv')));
const LEVEL = getArg('--level', ''); // '強' で強シグナルのみ
const MIN_SCORE = parseInt(getArg('--min-score', '0'), 10) || 0;
const LIMIT = parseInt(getArg('--limit', '0'), 10) || 0;
const KEEP_IT = has('--keep-it');
const DEDUPE_HISTORY = has('--dedupe-history'); // 既定OFF（既存CRMリードの再アプローチ層のため）
const TODAY = new Date();

const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());

// ── 列名（BALES 266列構造）──────────────────────────────────────
const C = {
  id: 'システム管理情報：ID', no: 'システム管理情報：No', created: 'システム管理情報：リード作成日時',
  url: 'システム管理情報：リードURL', name: '会社情報：会社名', phone: '会社情報：電話',
  phone2: '担当者情報：電話', web: '会社情報：Webサイト', industry: '会社情報：業種',
  emp: '会社情報：従業員規模', pref: '会社情報：住所：都道府県',
  dept: '担当者情報：部署', title: '担当者情報：役職', sei: '担当者情報：姓', mei: '担当者情報：名',
  mail: '担当者情報：メール', stage: 'リード関連情報：最終リードステージ', owner: 'リード関連情報：リード所有者',
  pending: 'カスタム情報：ペンディング理由', ats: 'カスタム情報：利用中ATS',
  hire: 'カスタム情報：採用人数(選択リスト)', kento: 'カスタム情報：検討開始時期',
  banned: 'カスタム情報：アプローチ禁止の種類',
  callAt: 'コール結果1：開始日時', callResult: 'コール結果1：結果', callComment: 'コール結果1：コメント',
  lostAt: 'カスタム情報：失注商談失注日', lostWhy: 'カスタム情報：失注商談失注理由大',
};

// ── 除外ルール ───────────────────────────────────────────────────
// 架電しても新卒ATSの話にならない／してはいけない構造的ブロッカー
const PENDING_BLOCK = new Set([
  '新卒やってない', '新卒担当ではない', '従業員数49名以下', '接触人数が30人以下', '採用人数が1~2名',
]);
const REFUSAL_BLOCK = new Set(['アプローチ禁止・架電拒否', '新規営業を一律お断り']);
// 失注理由の構造的ブロッカー（接触人数が少なすぎてMOCHICAが成立しないと判定済み）
const LOST_BLOCK = new Set(['接触人数不足']);
// 氏名でない姓（名指し架電ができない＝品質フラグ。除外はしない）
const PLACEHOLDER_SEI = /^(\[.*\]|担当者|採用担当者?|人事担当|ご?担当者?様?|不明|未定|なし|御中|Unknown)$/i;

// 従業員規模ブラケット（BALESは "100" 等の数値文字列）
function empNum(v) {
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// 採用人数(選択リスト) "6～10名" → 下限値 6
function hireNum(v) {
  const s = String(v || '');
  const m = s.match(/([0-9]+)/);
  if (!m) return null;
  return parseInt(m[1], 10);
}
// "7月" → 今から何ヶ月先か（0-11）。不明は null。
function monthsAhead(kento) {
  const m = String(kento || '').match(/^([0-9]{1,2})月$/);
  if (!m) return null;
  const mon = parseInt(m[1], 10);
  if (mon < 1 || mon > 12) return null;
  return (mon - (TODAY.getMonth() + 1) + 12) % 12;
}
function toTime(s) {
  const t = Date.parse(String(s || '').replace(/\//g, '-'));
  return Number.isFinite(t) ? t : 0;
}

// ── 採点（0-100・透明な加点式）────────────────────────────────────
function scoreLead(rec, needs) {
  const why = [];
  let s = 0;
  if (needs.level === '強') { s += 45; why.push('母集団課題を明言+45'); }
  else { s += 30; why.push('母集団が薄い実態+30'); }

  const sei = g(rec, C.sei);
  const named = sei && !PLACEHOLDER_SEI.test(sei);
  if (named) { s += 10; why.push('名指し可+10'); }

  const hire = hireNum(g(rec, C.hire));
  if (hire != null && hire >= ICP.HIRE_MIN) { s += 15; why.push(`新卒${g(rec, C.hire)}+15`); }
  else if (hire != null && hire >= 3) { s += 8; why.push(`新卒${g(rec, C.hire)}+8`); }
  else { s += 4; why.push('採用人数不明+4'); }

  const emp = empNum(g(rec, C.emp));
  if (emp != null && emp >= ICP.EMP_SWEET_MIN && emp <= ICP.EMP_SWEET_MAX) { s += 14; why.push(`従業員${emp}名(スイート)+14`); }
  else if (emp != null && emp >= ICP.EMP_MIN && emp <= ICP.EMP_MAX) { s += 10; why.push(`従業員${emp}名+10`); }
  else if (emp == null) { s += 5; why.push('規模不明+5'); }

  const ats = g(rec, C.ats);
  if (ats === '無し') { s += 8; why.push('他社ATSなし+8'); }
  else if (!ats) { s += 4; why.push('ATS不明+4'); }
  else { why.push(`${ats}導入(加点なし)`); }

  const stage = g(rec, C.stage);
  if (/リサイクル|新規|担当者未接触|コネクト|NEW|Qualified|潜在/.test(stage)) { s += 7; why.push('再架電可ステージ+7'); }
  else if (/アーカイブ/.test(stage)) { s += 2; why.push('アーカイブ+2'); }
  else { s += 4; }

  const ma = monthsAhead(g(rec, C.kento));
  if (ma != null && ma <= 2) { s += 8; why.push(`検討開始${g(rec, C.kento)}(直近)+8`); }
  else if (ma != null && ma <= 5) { s += 4; why.push(`検討開始${g(rec, C.kento)}+4`); }

  if (g(rec, C.lostAt)) { s += 5; why.push(`過去商談あり(失注:${g(rec, C.lostWhy) || '理由不明'})+5`); }

  return { score: Math.min(100, s), why: why.join(' / '), named, hire, emp };
}
// 閾値は実分布に合わせる（強シグナル×到達性×ICP適合が揃った上澄みをAに寄せる）
const priorityOf = (s) => (s >= 90 ? 'A：今週架電' : s >= 78 ? 'B：次点' : 'C：ナーチャリング');

// ── メイン ───────────────────────────────────────────────────────
const raw = fs.readFileSync(BALES, 'utf8');
const parsed = parseCsv(raw);
const HEADERS = parsed[0];
const { records } = rowsToRecords(parsed);
console.log(`[boshudan] BALES既存リード ${records.length}件（${HEADERS.length}列）を走査`);

// MOCHICA既存顧客インデックス
const custIdx = createMatchIndex();
if (fs.existsSync(CUSTOMERS)) {
  const { records: cust } = readCsv(fs.readFileSync(CUSTOMERS, 'utf8'));
  for (const c of cust) custIdx.addRecord(c, 'MOCHICA顧客');
  console.log(`[boshudan] MOCHICA既存顧客 ${custIdx.size}社を除外対象に読込`);
}
const ledgerIdx = loadLedger(DEFAULT_LEDGER);

const drop = {};
const bump = (k) => { drop[k] = (drop[k] || 0) + 1; };
const cand = [];
let needStrong = 0; let needMid = 0; let ledgerHit = 0;

for (const rec of records) {
  const needs = detectBoshudanNeeds(rec);
  if (!needs.level) continue;
  if (LEVEL && needs.level !== LEVEL) continue;
  if (needs.level === '強') needStrong++; else needMid++;

  // ── 除外 ──
  if (g(rec, C.banned)) { bump('アプローチ禁止（' + g(rec, C.banned).slice(0, 12) + '…）'); continue; }
  const refusal = classifyRefusal({ comment: g(rec, C.callComment), pending: g(rec, C.pending) });
  if (REFUSAL_BLOCK.has(refusal)) { bump('架電拒否・新規営業お断り'); continue; }
  if (PENDING_BLOCK.has(g(rec, C.pending))) { bump('ペンディング理由：' + g(rec, C.pending)); continue; }
  if (g(rec, C.hire) === '1～2名') { bump('採用1~2名（採用フロア未満）'); continue; }
  const phone = g(rec, C.phone) || g(rec, C.phone2);
  if (!phone) { bump('電話番号なし（架電不能）'); continue; }
  // コンバート済＝商談化した層。**失注済みなら再アプローチの本命**（失注リサイクル）、
  // 失注日が無いものは進行中/受注済みなので架電リストに入れない。
  const lostAt = g(rec, C.lostAt);
  if (/コンバート/.test(g(rec, C.stage)) && !lostAt) { bump('商談進行中/受注済み（失注日なし）'); continue; }
  if (LOST_BLOCK.has(g(rec, C.lostWhy))) { bump('失注理由：' + g(rec, C.lostWhy)); continue; }
  if (custIdx.has(rec)) { bump('MOCHICA既存顧客'); continue; }
  if (!KEEP_IT && isExcludedIndustry(g(rec, C.industry))) { bump('IT/ソフト（ICP絶対除外）'); continue; }
  const emp = empNum(g(rec, C.emp));
  if (emp != null && emp < ICP.EMP_MIN) { bump(`従業員${ICP.EMP_MIN}名未満（判明分のみ）`); continue; }
  if (ledgerIdx.has(rec)) { ledgerHit++; if (DEDUPE_HISTORY) { bump('納品台帳に既出'); continue; } }

  const sc = scoreLead(rec, needs);
  if (sc.score < MIN_SCORE) { bump('スコア下限未満'); continue; }
  cand.push({ rec, needs, sc, phone, recency: Math.max(toTime(g(rec, C.callAt)), toTime(g(rec, C.created))) });
}

// ── 1社1行に名寄せ（同一社の複数リードは最良の1件を残す）──────────
const best = new Map();
const rank = (x) => (x.needs.level === '強' ? 1000 : 0) + x.sc.score;
for (const x of cand) {
  const key = normCompanyName(g(x.rec, C.name)) || ('id:' + g(x.rec, C.id));
  const prev = best.get(key);
  if (!prev || rank(x) > rank(prev) || (rank(x) === rank(prev) && x.recency > prev.recency)) best.set(key, x);
}
let rows = [...best.values()];
const dupeMerged = cand.length - rows.length;

rows.sort((a, b) => rank(b) - rank(a) || b.recency - a.recency);
if (LIMIT) rows = rows.slice(0, LIMIT);

// ── 出力① BALES 266列（取込用・原本の値をそのまま／Noだけ振り直し）──
const outRecs = rows.map((x, i) => {
  const o = {};
  for (const h of HEADERS) o[h] = x.rec[h] == null ? '' : x.rec[h];
  o[C.no] = String(i + 1);
  return o;
});
fs.writeFileSync(OUT, '﻿' + toCsv(HEADERS, outRecs), 'utf8');

// ── 出力② 根拠つきレビューCSV（架電者が読む用）──────────────────
const R_HEADERS = ['優先度', 'スコア', 'ニーズ強度', 'ニーズ分類', '根拠（実際の記録）', '会社名', '電話', '担当者姓', '担当者名',
  '名指し可否', '役職', '部署', '採用人数', '従業員規模', '業種', '都道府県', '利用中ATS', '検討開始時期',
  '最終リードステージ', 'ペンディング理由', '接点区分', '失注日', '失注理由',
  '直近コール日時', '直近コール結果', 'リード所有者', 'スコア根拠',
  'Webサイト', 'リードURL', 'リードID'];
const reviewRecs = rows.map((x) => ({
  優先度: priorityOf(x.sc.score),
  スコア: String(x.sc.score),
  ニーズ強度: x.needs.level,
  ニーズ分類: x.needs.categories.join('／'),
  '根拠（実際の記録）': x.needs.evidence.replace(/\s+/g, ' ').slice(0, 400),
  会社名: g(x.rec, C.name),
  電話: x.phone,
  担当者姓: g(x.rec, C.sei),
  担当者名: g(x.rec, C.mei),
  名指し可否: x.sc.named ? '実名' : '窓口名のみ',
  役職: g(x.rec, C.title),
  部署: g(x.rec, C.dept),
  採用人数: g(x.rec, C.hire),
  従業員規模: g(x.rec, C.emp),
  業種: g(x.rec, C.industry),
  都道府県: g(x.rec, C.pref),
  利用中ATS: g(x.rec, C.ats),
  検討開始時期: g(x.rec, C.kento),
  最終リードステージ: g(x.rec, C.stage),
  ペンディング理由: g(x.rec, C.pending),
  接点区分: g(x.rec, C.lostAt) ? '過去商談あり（失注リサイクル）' : '未商談（架電接点のみ）',
  失注日: g(x.rec, C.lostAt).replace(/ 0:00:00$/, ''),
  失注理由: g(x.rec, C.lostWhy),
  直近コール日時: g(x.rec, C.callAt),
  直近コール結果: g(x.rec, C.callResult),
  リード所有者: g(x.rec, C.owner),
  スコア根拠: x.sc.why,
  Webサイト: g(x.rec, C.web),
  リードURL: g(x.rec, C.url),
  リードID: g(x.rec, C.id),
}));
fs.writeFileSync(REVIEW, '﻿' + toCsv(R_HEADERS, reviewRecs), 'utf8');

// ── サマリ ───────────────────────────────────────────────────────
const pct = (n, d) => (d ? (n / d * 100).toFixed(0) + '%' : '—');
const tally = (fn) => { const m = {}; for (const x of rows) { const k = fn(x) || '(不明)'; m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };

console.log(`\n─────────────────────────────────────────────`);
console.log(`[boshudan] 母集団課題ニーズ 判定`);
console.log(`─────────────────────────────────────────────`);
console.log(`  強（母集団を課題と明言）      ${needStrong}件`);
console.log(`  中（応募/学生が集まらない等） ${needMid}件`);
console.log(`  合計ヒット                    ${needStrong + needMid}件 / 全${records.length}件`);
console.log(`\n[boshudan] 除外（架電不能・アプローチ不可・ICP不適合）`);
for (const [k, v] of Object.entries(drop).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}件  ${k}`);
console.log(`  ${String(dupeMerged).padStart(4)}件  同一社の重複リードを統合（1社1行）`);
console.log(`\n[boshudan] 完成リスト ${rows.length}社`);
console.log(`  優先度       ${tally((x) => priorityOf(x.sc.score)).map(([k, v]) => `${k}:${v}`).join(' / ')}`);
console.log(`  ニーズ強度   ${tally((x) => x.needs.level).map(([k, v]) => `${k}:${v}`).join(' / ')}`);
console.log(`  名指し可能   ${rows.filter((x) => x.sc.named).length}社（${pct(rows.filter((x) => x.sc.named).length, rows.length)}）`);
console.log(`  電話あり     ${rows.length}社（100%・架電可能が入る条件）`);
console.log(`  他社ATSなし  ${rows.filter((x) => g(x.rec, C.ats) === '無し').length}社`);
console.log(`  新卒6名以上  ${rows.filter((x) => (hireNum(g(x.rec, C.hire)) || 0) >= ICP.HIRE_MIN).length}社`);
console.log(`  接点区分     ${tally((x) => (g(x.rec, C.lostAt) ? '過去商談あり（失注リサイクル）' : '未商談（架電接点のみ）')).map(([k, v]) => `${k}:${v}`).join(' / ')}`);
console.log(`  スコア分布   ${[[90, 100], [80, 89], [70, 79], [60, 69], [0, 59]].map(([lo, hi]) => `${lo}-${hi}:${rows.filter((x) => x.sc.score >= lo && x.sc.score <= hi).length}`).join(' / ')}`);
console.log(`\n  ニーズ分類の内訳`);
const catTally = {};
for (const x of rows) for (const c of x.needs.categories) catTally[c] = (catTally[c] || 0) + 1;
for (const [k, v] of Object.entries(catTally).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}社  ${k}`);
console.log(`\n  上位10社`);
for (const x of rows.slice(0, 10)) {
  console.log(`    ${String(x.sc.score).padStart(3)}点 ${x.needs.level} ${g(x.rec, C.name)}（${g(x.rec, C.sei)}${g(x.rec, C.mei)}様 / ${g(x.rec, C.hire) || '採用数不明'} / ${g(x.rec, C.emp) || '規模不明'}）`);
}
console.log(`\n[boshudan] 納品台帳と重複する企業: ${ledgerHit}社${DEDUPE_HISTORY ? '（除外済み）' : '（既存CRMリードの再アプローチ層のため既定では残す。--dedupe-history で除外）'}`);
console.log(`[boshudan] out: ${path.relative(ROOT, OUT)}（${HEADERS.length}列・BALES構造一致）`);
console.log(`[boshudan] out: ${path.relative(ROOT, REVIEW)}（根拠つきレビュー用）`);
