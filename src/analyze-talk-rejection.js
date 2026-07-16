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

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BALES = path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
const SF = path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv');

const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());
const z2h = (s) => String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const norm = (s) => z2h(s).replace(/\s+/g, ' ');
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
// 構造化ペンディング理由 → 統合カテゴリへのマップ
const PEND_MAP = {
  '検討時期が3カ月以上先': '検討時期が先・タイミング',
  '他社ツール契約済み': '既存ツール・他社ATS/媒体で充足',
  '採用にかける予算なし': '予算なし',
  'ニーズ違い': 'ニーズ・課題感なし',
  '採用人数が1~2名': '採用規模が小さい・縮小',
  '従業員数49名以下': '採用規模が小さい・縮小',
  '接触人数が30人以下': '採用規模が小さい・縮小',
  '新卒やってない': '新卒採用していない・担当外',
  '新卒担当ではない': '新卒採用していない・担当外',
  'セキュリティor会社の方針でLINE NG': 'LINE方針・セキュリティNG',
  '機能不足': '機能不足',
  '代理店案件': 'その他',
};
// コメント自由記述の分類ルール（優先度順・最初にマッチした1カテゴリ）
const REASON_RULES = [
  ['アプローチ禁止・架電拒否', /アプローチ禁止|かけないで|架けないで|かけないよう|架電禁止|禁止申請|連絡(は)?(不要|しないで|やめて|不可)|二度と(かけ|電話|連絡)|着信拒否|出禁/],
  ['新規営業を一律お断り', /新規(の)?(営業|サービス|ツール|提案|案件)?(は)?(お|全て)?断|新規(は)?(不可|なし|受け付け|お断り|停止|NG)|新規営業|飛び込み(営業)?(は)?(断|お断|不可|NG)|テレアポ(は)?(断|お断|不可|NG)|決まったところ(しか|のみ|と)|既存(の)?(取引|お客|顧客)(先)?(のみ|しか|だけ)|付き合いのある(ところ|会社)(のみ|しか|だけ)/],
  ['新卒採用していない・担当外', /新卒(は)?(やってな|やっていな|やらな|行わな|しない|してな|していな|採用(はし|してい|し)?(てい)?な|取(ら|って)な|募集(してい|し)?な|予定(は)?な|するか(未定|不明))|中途(が|は)?(メイン|専門|のみ|中心|だけ)|新卒担当(では)?(な|外)/],
  ['LINE方針・セキュリティNG', /LINE.{0,8}(NG|禁止|使えな|不可|入れられ|導入でき|方針|セキュリティ|ダメ|だめ)|(方針|セキュリティ).{0,8}LINE/i],
  ['既存ツール・他社ATS/媒体で充足', /他社|既存(の)?(ツール|システム|ATS)|導入済|契約済|入れている|入れてる|使っている|使ってる|利用している|利用中|かんり君|管理くん|sonar|i-web|iweb|キャリタス|あさがく|HRMOS|ジョブカン|一本化|(マイナビ|リクナビ|ナビ|媒体)(のみ|だけ|で)|LINE(を)?(既に|もう)?(使|導入|利用)/i],
  ['予算なし', /予算(が)?(な|無|厳し|捻出|削減|決ま|とれ|取れ|確保でき|きつ)|お金(を)?かけ(な|られ)|コスト(は)?かけ(な|られ)|費用(は)?(な|出せ|かけ(な|られ))/],
  ['ニーズ・課題感なし', /ニーズ(が|は)?(な|違)|課題(感)?(は)?(特に|あまり)?(な|無|ない)|必要(性|は)?(特に|あまり)?(な|無|ない|感じ(な|てい?な))|困って(いな|な)|間に合って|足りて(いる|る)|充足|考えて(いな|な)|検討して(いな|な)|関心(が)?(な|薄)|興味(が)?(な|薄)|結構です|大丈夫です/],
  ['検討時期が先・タイミング', /検討時期|時期(が)?(先|後|来期|来年|再来|じゃな)|来期|再来年|今(の)?(ところ|は)(検討|考|必要|大丈夫|結構)|まだ(先|早|検討)|落ち着いて|繁忙|終わって(から|落)|採用(が|は)?(終|落ち着|一段落|決ま)|決まった/],
  ['採用規模が小さい・縮小', /採用(人数|数|枠)(が)?(少|1|2|一|二|わずか|数名)|[12](〜|~|-)2名|少人数|採用(を)?(縮小|抑制|絞|ストップ|停止|見送|中止)|採用(が)?(な|無)|募集(が)?(な|終)/],
  ['即切り・一方的遮断', /すぐ切ら|ガチャ切り|一方的|話(を)?(聞かない|聞いてもらえ|できな)|忙しい(ので)?(切|お断)|取り付く島|冒頭(から)?(断|必要)|話にならな/],
  ['決裁権限なし・担当者権限外', /決裁(権)?(が)?(な|外)|権限(が)?(な|外)|私(で)?は(決め|判断|わから)|上(に|の)(確認|判断|決裁|相談)|管轄(外|違)|他部署|別(の)?部署/],
];
function classifyComment(text) {
  const t = norm(text);
  for (const [label, re] of REASON_RULES) if (re.test(t)) return label;
  return t ? 'その他（分類外の自由記述）' : '(コメントなし)';
}
// 統合分類：pendingを優先、'-'/空はコメント分類
function refusalReason(r) {
  const p = g(r, PEND);
  if (p && p !== '-' && p !== '5回以上連絡したが不在') {
    if (PEND_MAP[p]) return PEND_MAP[p];
  }
  return classifyComment(g(r, CMT));
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
const TALK_FIELDS = [CMT, 'カスタム情報：顧客の現状', 'カスタム情報：顧客の課題感', 'コメント1：内容'];
const talkText = (r) => TALK_FIELDS.map((f) => g(r, f)).join(' 　 ');
const TALK_RULES = [
  ['LINE連携ATSの提案（コア訴求）', /LINE.{0,10}(連携|連動|採用管理|ATS|システム|活用|使)|LINEと(連携|連動)/i],
  ['母集団形成の文脈', /母集団|エントリー(数|増)|応募(数|者|増)|説明会|ナビ|マイナビ|リクナビ|媒体|集客/],
  ['つなぎ止め・歩留まり改善', /つなぎ止め|繋ぎ止め|繋止め|歩留|離脱|辞退(防|抑|率)|承諾(率|待)|フォロー|温度感|内定者(フォロー|管理)/],
  ['選考・面接管理の効率化', /選考(管理|フロー|状況)|面接(管理|調整|日程)|日程調整|管理(が)?(煩雑|大変|手間|工数)|エクセル|スプレッド|手作業|アナログ/],
  ['学生コミュニケーション/連絡改善', /連絡(が)?(つか|取れ|遅|来な)|返信(率|が)|既読|反応(が)?(な|薄|よ)|コミュニケーション|接点|やり取り/],
  ['現行ツール不満・見直し', /(不満|使いにく|使いづら|課題|困|不便|見直し|乗り換え|切り替え|リプレイス|高い|コスト).{0,12}(ツール|ATS|システム|管理|くん|sonar|i-web)|(ツール|ATS|システム).{0,12}(不満|使いにく|困|見直|乗り換|切り替)/i],
  ['採用計画・目標人数の具体化', /採用目標|目標人数|採用(予定)?人数[：:]?\s*[0-9０-９]|内定承諾|採用計画|来年度(採用|の)/],
  ['料金・費用対効果の訴求', /料金|費用|価格|コスト(削減|パフォーマンス|感)|安く|お得|無料|トライアル|導入費/],
  ['他社導入事例・実績の提示', /事例|実績|導入企業|同業|他社(も|で)(使|導入)|同じ(業界|規模)/],
  ['期日・タイミングの合致（今がタイミング）', /今(が)?(タイミング|ちょうど|検討|見直)|来期(から)?(検討|導入)|(次|来)年度(に向|から)|ちょうど(探|検討|見直)/],
];
const talkCat = new Map();
const talkSample = new Map();
for (const r of appo) {
  const t = norm(talkText(r));
  for (const [label, re] of TALK_RULES) {
    if (re.test(t)) {
      talkCat.set(label, (talkCat.get(label) || 0) + 1);
      if (!talkSample.has(label)) {
        const m = t.match(re);
        const idx = m ? t.indexOf(m[0]) : 0;
        talkSample.set(label, t.slice(Math.max(0, idx - 10), idx + 45).trim());
      }
    }
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
// 対象語彙（トーク/文脈の要）を固定辞書でカウントし、出現率の比(lift)を取る
const LEX = [
  'LINE', '母集団', 'つなぎ止め', '歩留', '内定者', '説明会', 'マイナビ', 'リクナビ', 'ナビ',
  '面接', '選考', '日程調整', '管理', 'エクセル', '手作業', '連絡', '返信', '既読',
  '事例', '実績', '料金', '費用', '無料', 'トライアル', '予算', '課題', 'ニーズ',
  '検討', '来期', '見直し', '乗り換え', '不満', '効率', '工数', 'フォロー', '温度感',
  '承諾', '辞退', 'エントリー', '応募', '母数', '接点',
];
function lexRate(rows, field) {
  const cnt = {}; LEX.forEach((w) => (cnt[w] = 0));
  const texts = rows.map((r) => norm([CMT, 'カスタム情報：顧客の現状', 'カスタム情報：顧客の課題感'].map((f) => g(r, f)).join(' ')));
  for (const t of texts) for (const w of LEX) if (t.includes(w)) cnt[w]++;
  return cnt;
}
const aCnt = lexRate(appo);
const rCnt = lexRate(refused);
const liftRows = LEX.map((w) => {
  const ar = aCnt[w] / appo.length;
  const rr = rCnt[w] / refused.length;
  const lift = rr > 0 ? ar / rr : (ar > 0 ? Infinity : 0);
  return { 語: w, アポ出現率: ar, お断り出現率: rr, lift };
}).sort((a, b) => b.lift - a.lift);
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
