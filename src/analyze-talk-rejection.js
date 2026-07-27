'use strict';
/**
 * analyze-talk-rejection（採用担当者接続後の①断わり理由 / ②アポ獲得トーク傾向 分析）
 * =====================================================================
 * ■ データソース
 *   - BALES: data/BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv
 *            22,892件・266列。架電履歴（コール結果／コメント／ペンディング理由／
 *            失注理由／顧客の現状・課題感）を持つ唯一の情報源。
 *   - SF   : data/セールスフォースMOCHICA参照 …csv（Salesforceレポート形式）。
 *            86,679件だが「リード状況」1列のみで架電メモ・断り理由・トークを持たない。
 *            → 実質の分析はBALESに依拠し、SFはリード状況ファネルの参考に留める。
 *
 * ■「採用担当者接続後」の定義
 *   コール結果1：結果 が「担当者接触：…」で始まる = 採用担当者に接続できた架電。
 *     担当者接触：お断り / アポ獲得 / 営業フォロー の3種。
 *   （担当者不在・受付ブロック・鳴りっぱなし等は“接続前”なので分母から除外）
 *
 * ■ 出力
 *   data/analysis-断り理由.csv         … 断り理由カテゴリ×件数×比率×代表例
 *   data/analysis-アポ獲得トーク.csv    … トーク要素カテゴリ×件数×比率×代表例
 *   data/analysis-talk-lift.csv        … アポ獲得 vs お断り の語彙lift（トークの決定要因）
 *   標準出力に全サマリ。
 *
 *   node src/analyze-talk-rejection.js
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToRecords, toCsv } = require('./csv');
// 断り理由/トーク要素/語彙lift の規則辞書は共有モジュールを単一の真実の源とする
// （リアルタイム運用の telapo-*.js と同一ロジックを共用）。
const TA = require('./talk-analysis');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BALES = path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
const SF = path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv');

const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());
const norm = TA.norm;
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '-');

// ─────────────────────────────────────────────────────────────
// 読み込み
// ─────────────────────────────────────────────────────────────
const { records } = rowsToRecords(parseCsv(fs.readFileSync(BALES, 'utf8')));

// コール結果でコホート分割
const RES = 'コール結果1：結果';
const CMT = 'コール結果1：コメント';
const PEND = 'カスタム情報：ペンディング理由';

const reached = records.filter((r) => g(r, RES).startsWith('担当者接触：')); // 採用担当者に接続できた
const refused = records.filter((r) => g(r, RES) === '担当者接触：お断り');
const appo = records.filter((r) => g(r, RES) === '担当者接触：アポ獲得');
const follow = records.filter((r) => g(r, RES) === '担当者接触：営業フォロー');

// ─────────────────────────────────────────────────────────────
// 0) 接続ファネル
// ─────────────────────────────────────────────────────────────
function distField(rows, col) {
  const m = new Map();
  for (const r of rows) { const v = g(r, col) || '(空白)'; m.set(v, (m.get(v) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
const callDone = records.filter((r) => g(r, RES) !== '');
console.log('════════════════════════════════════════════════════════════');
console.log(' 採用担当者接続後の ①断わり理由 / ②アポ獲得トーク 分析');
console.log('════════════════════════════════════════════════════════════');
console.log('\n■ 母集団');
console.log('  BALES総リード          :', records.length.toLocaleString(), '件');
console.log('  うち架電実績あり        :', callDone.length.toLocaleString(), '件');
console.log('  うち採用担当者に接続    :', reached.length.toLocaleString(), '件（コール結果=担当者接触：*）');
console.log('\n■ コール結果1：結果 の全分布（架電実績', callDone.length.toLocaleString(), '件）');
for (const [k, v] of distField(callDone, RES)) {
  const mark = k.startsWith('担当者接触：') ? ' ★接続' : '';
  console.log('   ' + String(v).padStart(6) + '  ' + pct(v, callDone.length).padStart(6) + '  ' + k + mark);
}
console.log('\n■ 採用担当者“接続後”の結末（分母=接続', reached.length.toLocaleString(), '件）');
[['お断り', refused.length], ['アポ獲得', appo.length], ['営業フォロー', follow.length]].forEach(([k, v]) =>
  console.log('   ' + String(v).padStart(6) + '  ' + pct(v, reached.length).padStart(6) + '  担当者接触：' + k));

// ─────────────────────────────────────────────────────────────
// 1) 断わり理由分析（お断り n件）
//    (a) 構造化ペンディング理由のクロス集計
//    (b) 自由記述コメントの理由分類（優先度順の単一分類）
// ─────────────────────────────────────────────────────────────
console.log('\n\n════════ ① 断わり理由分析（担当者接触：お断り ' + refused.length.toLocaleString() + '件）════════');

console.log('\n【1-a】構造化フィールド「ペンディング理由」のクロス集計（※約6割が未入力）');
const pendDist = distField(refused, PEND);
for (const [k, v] of pendDist) {
  console.log('   ' + String(v).padStart(6) + '  ' + pct(v, refused.length).padStart(6) + '  ' + (k === '-' ? '-（理由未入力）' : k));
}

// ── 統合分類：構造化ペンディング理由があれば優先採用、無ければコメント自由記述を分類 ──
//   規則辞書（PEND_MAP / REASON_RULES / classifyComment）は talk-analysis.js に集約。
const PEND_MAP = TA.PEND_MAP;
const classifyComment = TA.classifyComment;
// 統合分類：pendingを優先、'-'/空はコメント分類（共有ロジックへ委譲）
function refusalReason(r) {
  return TA.classifyRefusal({ comment: g(r, CMT), pending: g(r, PEND) });
}
console.log('\n【1-b】統合分類（構造化ペンディング理由を優先＋自由記述で補完 / お断り' + refused.length.toLocaleString() + '件）');
const rCat = new Map();
const rSample = new Map();
for (const r of refused) {
  const cat = refusalReason(r);
  rCat.set(cat, (rCat.get(cat) || 0) + 1);
  if (!rSample.has(cat)) {
    const s = norm(g(r, CMT)).slice(0, 55);
    if (s) rSample.set(cat, s);
  }
}
const rCatArr = [...rCat.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, v] of rCatArr) {
  console.log('   ' + String(v).padStart(6) + '  ' + pct(v, refused.length).padStart(6) + '  ' + k);
  const s = rSample.get(k); if (s && !k.startsWith('(')) console.log('           例:「' + s + '…」');
}

// 断り理由CSV
const refuseRows = rCatArr.map(([k, v]) => ({
  理由カテゴリ: k, 件数: v, 比率: pct(v, refused.length), 代表例: rSample.get(k) || '',
}));
fs.writeFileSync(path.join(DATA, 'analysis-断り理由.csv'),
  '﻿' + toCsv(['理由カテゴリ', '件数', '比率', '代表例'], refuseRows), 'utf8');

// ─────────────────────────────────────────────────────────────
// 2) アポ獲得トーク傾向分析（アポ獲得 n件）
//    (a) トーク要素カテゴリ分類（複数該当可＝要素の出現率）
//    (b) 業種/規模/ATS別の獲得傾向
// ─────────────────────────────────────────────────────────────
console.log('\n\n════════ ② アポ獲得トーク傾向分析（担当者接触：アポ獲得 ' + appo.length.toLocaleString() + '件）════════');

// (a) トーク要素（複数該当可。コメント＋顧客の現状＋課題感を連結して判定）
//     TALK_RULES / 分類ロジックは talk-analysis.js を共用（telapo運用画面と同一）。
const TALK_FIELDS = [CMT, 'カスタム情報：顧客の現状', 'カスタム情報：顧客の課題感', 'コメント1：内容'];
const talkText = (r) => TALK_FIELDS.map((f) => g(r, f)).join(' 　 ');
const talkCat = new Map();
const talkSample = new Map();
for (const r of appo) {
  for (const { label, sample } of TA.classifyTalk(talkText(r)).elements) {
    talkCat.set(label, (talkCat.get(label) || 0) + 1);
    if (!talkSample.has(label)) talkSample.set(label, sample);
  }
}
console.log('\n【2-a】アポ獲得コメントに現れるトーク要素の出現率（複数該当可）');
const talkArr = [...talkCat.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, v] of talkArr) {
  console.log('   ' + String(v).padStart(5) + '  ' + pct(v, appo.length).padStart(6) + '  ' + k);
  const s = talkSample.get(k); if (s) console.log('           例:「…' + s + '…」');
}
const talkRows = talkArr.map(([k, v]) => ({
  トーク要素: k, 出現数: v, 出現率: pct(v, appo.length), 代表例: talkSample.get(k) || '',
}));
fs.writeFileSync(path.join(DATA, 'analysis-アポ獲得トーク.csv'),
  '﻿' + toCsv(['トーク要素', '出現数', '出現率', '代表例'], talkRows), 'utf8');

// (b) 属性別のアポ獲得傾向（業種・従業員規模・利用中ATS）
function crossRate(label, col, cohortRows, baseRows, topN) {
  // cohort内の分布 と base(=接続全体)内の分布 を比べ、アポ獲得のかたよりを見る
  const cohortD = new Map(); const baseD = new Map();
  for (const r of baseRows) { const v = g(r, col) || '(空白)'; baseD.set(v, (baseD.get(v) || 0) + 1); }
  for (const r of cohortRows) { const v = g(r, col) || '(空白)'; cohortD.set(v, (cohortD.get(v) || 0) + 1); }
  console.log('\n【2-b】' + label + '別アポ獲得率（分母=その属性で接続できた件数, 上位' + (topN || 10) + '）');
  const arr = [...baseD.entries()]
    .filter(([, n]) => n >= 20) // 分母20件以上のみ
    .map(([k, base]) => [k, cohortD.get(k) || 0, base])
    .sort((a, b) => (b[1] / b[2]) - (a[1] / a[2]));
  for (const [k, c, base] of arr.slice(0, topN || 10)) {
    console.log('   ' + pct(c, base).padStart(6) + '  (' + String(c).padStart(3) + '/' + String(base).padStart(4) + ')  ' + k);
  }
}
crossRate('業種', '会社情報：業種', appo, reached, 12);
crossRate('従業員規模', '会社情報：従業員規模', appo, reached, 12);
crossRate('利用中ATS', 'カスタム情報：利用中ATS', appo, reached, 10);

// ─────────────────────────────────────────────────────────────
// 3) トークlift分析：アポ獲得コメント vs お断りコメント の語彙差
//    → アポ獲得に“効いている”語（お断りに比べて過剰出現する語）を炙り出す
// ─────────────────────────────────────────────────────────────
console.log('\n\n════════ ③ トークlift分析（アポ獲得 vs お断り の語彙差）════════');
// 対象語彙（トーク/文脈の要）を固定辞書でカウントし、出現率の比(lift)を取る。
//   LEX / lift算出は talk-analysis.js を共用（telapo運用画面と同一）。
const liftText = (r) => [CMT, 'カスタム情報：顧客の現状', 'カスタム情報：顧客の課題感'].map((f) => g(r, f)).join(' ');
const liftRows = TA.computeLift(appo.map(liftText), refused.map(liftText)).map((r) => ({
  語: r.word, アポ出現率: r.appoRate, お断り出現率: r.refuseRate, lift: r.lift,
}));
console.log('\n【3】語彙の出現率とlift（アポ出現率 ÷ お断り出現率）。lift>1=アポに効く語, <1=お断りに多い語');
console.log('   ' + 'lift'.padStart(6) + '  ' + 'アポ%'.padStart(6) + '  ' + 'お断%'.padStart(6) + '  語');
for (const row of liftRows) {
  const liftStr = row.lift === Infinity ? '  ∞' : row.lift.toFixed(2);
  console.log('   ' + liftStr.padStart(6) + '  ' + (100 * row.アポ出現率).toFixed(1).padStart(6) + '  ' +
    (100 * row.お断り出現率).toFixed(1).padStart(6) + '  ' + row.語);
}
fs.writeFileSync(path.join(DATA, 'analysis-talk-lift.csv'),
  '﻿' + toCsv(['語', 'アポ出現率', 'お断り出現率', 'lift'],
    liftRows.map((r) => ({
      語: r.語, アポ出現率: (100 * r.アポ出現率).toFixed(1) + '%',
      お断り出現率: (100 * r.お断り出現率).toFixed(1) + '%',
      lift: r.lift === Infinity ? '∞' : r.lift.toFixed(2),
    }))), 'utf8');

// ─────────────────────────────────────────────────────────────
// 4) SFリード状況ファネル（参考：架電メモは持たないため状況分布のみ）
// ─────────────────────────────────────────────────────────────
console.log('\n\n════════ ④ 参考：SFリスト（Salesforce）のリード状況分布 ════════');
try {
  const sfRows = parseCsv(fs.readFileSync(SF, 'utf8'));
  // 実ヘッダ行を検出（"リードID18" を含む行）
  let h = sfRows.findIndex((row) => row.some((c) => String(c).includes('リードID')));
  if (h < 0) h = 5;
  const headers = sfRows[h].map((c) => String(c).trim());
  const statusIdx = headers.findIndex((c) => c.includes('状況'));
  const body = sfRows.slice(h + 1).filter((r) => r.some((c) => String(c).trim() !== ''));
  console.log('  SFレコード:', body.length.toLocaleString(), '件 / 状況列:', headers[statusIdx] || '(不明)');
  const sd = new Map();
  for (const r of body) { const v = String(r[statusIdx] || '(空白)').trim() || '(空白)'; sd.set(v, (sd.get(v) || 0) + 1); }
  for (const [k, v] of [...sd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log('   ' + String(v).padStart(6) + '  ' + pct(v, body.length).padStart(6) + '  ' + k);
  }
  console.log('  ※SFは架電コメント/断り理由/トーク列を持たないため、断り理由・トーク分析はBALESに依拠。');
} catch (e) { console.log('  SF読込スキップ:', e.message); }

console.log('\n出力:');
console.log('  data/analysis-断り理由.csv');
console.log('  data/analysis-アポ獲得トーク.csv');
console.log('  data/analysis-talk-lift.csv');
