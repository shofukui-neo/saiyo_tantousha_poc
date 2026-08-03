'use strict';
/**
 * build-badnumber-list — BALES「架電不能（番号系）」リスト ビルダー
 * =====================================================================
 * BALESCLOUD の既存リード（22,892件）から、**電話番号そのものが機能していない**
 * 3区分だけを抜き出す。
 *
 *   ① 現在使われておりません  … 発信すると「現在使われておりません」の自動音声
 *   ② なりっぱなし            … コールし続けるが誰も出ない（＝実質デッド）
 *   ③ 番号不備                … 全く別の会社/個人宅に繋がる・桁欠け等の登録ミス
 *
 * ■ 判定ソース（precision優先の2段構え）
 *   1) ピックリスト『コール結果1：結果』… BALES標準の選択値。誤判定なし＝一次証拠
 *   2) 自由記述『コール結果1：コメント』『コメント1：内容』… 結果欄が別値（担当者不在等）
 *      でも本文で番号不良を報告しているケースを救済。
 *      ただし「LINEは使ってない」等の非電話文脈は NOT_PHONE ガードで落とす。
 *   どちらで拾ったかは出力の「判定根拠」列で区別できる（＝ピックリストのみに絞れる）。
 *
 * ■ 用途
 *   架電リストからの除去 / BALES側での番号是正・再調査キュー / タグ一括付与。
 *
 * 使い方:
 *   node src/build-badnumber-list.js
 *   node src/build-badnumber-list.js --picklist-only     # 一次証拠だけに絞る
 *   node src/build-badnumber-list.js --unique-company    # 1社1行に名寄せ
 *   node src/build-badnumber-list.js --out <csv> --bales-out <csv>
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
const { looseKey } = require('./company-match');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (k) => args.includes(k);

const BALES = path.resolve(getArg('--bales', path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv')));
const OUT = path.resolve(getArg('--out', path.join(DATA, 'bales-架電不能-番号系.csv')));
const BALES_OUT = path.resolve(getArg('--bales-out', path.join(DATA, 'leads-bales-badnumber.csv')));
const PICKLIST_ONLY = has('--picklist-only');
const UNIQUE_COMPANY = has('--unique-company');

// ── 列名（BALES 266列構造）──────────────────────────────────────
const C = {
  id: 'システム管理情報：ID', no: 'システム管理情報：No', created: 'システム管理情報：リード作成日時',
  url: 'システム管理情報：リードURL', name: '会社情報：会社名', phone: '会社情報：電話',
  phone2: '担当者情報：電話', web: '会社情報：Webサイト', industry: '会社情報：業種',
  emp: '会社情報：従業員規模', pref: '会社情報：住所：都道府県', city: '会社情報：住所：市区郡',
  dept: '担当者情報：部署', title: '担当者情報：役職', sei: '担当者情報：姓', mei: '担当者情報：名',
  mail: '担当者情報：メール', stage: 'リード関連情報：最終リードステージ', owner: 'リード関連情報：リード所有者',
  banned: 'カスタム情報：アプローチ禁止の種類',
  callAt: 'コール結果1：開始日時', callConn: 'コール結果1：接続状況',
  callResult: 'コール結果1：結果', callComment: 'コール結果1：コメント',
  memoAt: 'コメント1：日時', memo: 'コメント1：内容',
};
const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());

// ── 区分定義 ─────────────────────────────────────────────────────
// BALESピックリストの生値 → ユーザー呼称への正規化
const PICKLIST = {
  '現在使われていない': '現在使われておりません',
  '鳴りっぱなし': 'なりっぱなし',
  '番号不備': '番号不備',
};
const CATEGORIES = ['現在使われておりません', 'なりっぱなし', '番号不備'];

// 自由記述の拾い上げ（結果欄が別値の行だけに適用）
const TEXT_RULES = [
  ['現在使われておりません', /(現在)?(この)?(番号|電話)?[^。\n]{0,6}使われて(い|お)?(ない|りません|ません)|使われてない番号/],
  ['なりっぱなし', /(鳴|な|ナ)り(っ|ッ)(ぱ|パ|放)な?し/],
  ['番号不備', /番号不備|電話番号(が)?(違い|間違)|番号違い/],
];
// 「LINEは使ってない」「そのツールは使っていない」等＝番号の話ではない誤爆を落とす
const NOT_PHONE = /(LINE|ライン|ＬＩＮＥ|ツール|ATS|媒体|紹介|サービス|システム|ナビ|SNS|メール|管理くん|求人|エージェント)/i;
const TEXT_COLS = [C.callComment, C.memo];

function detectFromText(rec) {
  for (const col of TEXT_COLS) {
    const v = g(rec, col);
    if (!v) continue;
    for (const [cat, re] of TEXT_RULES) {
      const m = v.match(re);
      if (!m) continue;
      const ctx = v.slice(Math.max(0, m.index - 25), m.index + m[0].length + 15);
      if (cat === '現在使われておりません' && NOT_PHONE.test(ctx)) continue;
      return { cat, col, evidence: ctx.replace(/\s+/g, ' ').trim() };
    }
  }
  return null;
}

function normPhone(v) {
  const d = String(v || '').replace(/[^0-9]/g, '');
  return d.length >= 9 ? d : '';
}
function toTime(s) {
  const t = Date.parse(String(s || '').replace(/\//g, '-'));
  return Number.isFinite(t) ? t : 0;
}

// ── 抽出 ─────────────────────────────────────────────────────────
if (!fs.existsSync(BALES)) {
  console.error(`[badnumber] ✗ BALESリストが見つかりません: ${BALES}`);
  process.exit(1);
}
const { headers: HEADERS, records } = readCsv(fs.readFileSync(BALES, 'utf8'));

const hits = [];
const stat = { picklist: 0, text: 0, textSkipped: 0 };
for (const rec of records) {
  const raw = g(rec, C.callResult);
  const picked = PICKLIST[raw];
  let cat, source, evidence;
  if (picked) {
    cat = picked; source = 'コール結果（ピックリスト）'; evidence = raw;
    stat.picklist++;
  } else {
    const t = detectFromText(rec);
    if (!t) continue;
    if (PICKLIST_ONLY) { stat.textSkipped++; continue; }
    cat = t.cat; source = `自由記述（${t.col}）`; evidence = t.evidence;
    stat.text++;
  }
  hits.push({
    rec, cat, source, evidence,
    phone: g(rec, C.phone) || g(rec, C.phone2),
    recency: toTime(g(rec, C.callAt)) || toTime(g(rec, C.created)),
  });
}

// ── 重複整理 ─────────────────────────────────────────────────────
// 既定: 同一社×同一番号×同一区分の重複リードだけ畳む（別番号は別行で残す＝是正対象が消えない）
// --unique-company: 1社1行まで畳む
const ck = (h) => looseKey(g(h.rec, C.name)) || normCompanyName(g(h.rec, C.name)) || g(h.rec, C.id);
const keyOf = (h) => (UNIQUE_COMPANY ? ck(h) : `${ck(h)}|${normPhone(h.phone)}|${h.cat}`);
const CAT_RANK = { '番号不備': 3, '現在使われておりません': 2, 'なりっぱなし': 1 };
const best = new Map();
const dupCount = new Map();
for (const h of hits) {
  const k = keyOf(h);
  dupCount.set(k, (dupCount.get(k) || 0) + 1);
  const prev = best.get(k);
  const score = (x) => (x.source.startsWith('コール結果') ? 1000 : 0) + (CAT_RANK[x.cat] || 0);
  if (!prev || score(h) > score(prev) || (score(h) === score(prev) && h.recency > prev.recency)) best.set(k, h);
}
const rows = [...best.values()];
const merged = hits.length - rows.length;
rows.sort((a, b) => (CAT_RANK[b.cat] - CAT_RANK[a.cat]) || g(a.rec, C.name).localeCompare(g(b.rec, C.name), 'ja'));

// ── 出力① レビュー用（架電者/オペレーションが読む用）──────────────
const R_HEADERS = ['区分', '会社名', '電話', '担当者姓', '担当者名', '役職', '部署',
  '業種', '従業員規模', '都道府県', '市区郡', '最終リードステージ', 'リード所有者',
  '直近コール日時', 'コール結果', '接続状況', '判定根拠', '根拠テキスト', '同一条件の重複リード数',
  'Webサイト', 'メール', 'リードURL', 'リードID'];
const reviewRecs = rows.map((h) => ({
  区分: h.cat,
  会社名: g(h.rec, C.name),
  電話: h.phone,
  担当者姓: g(h.rec, C.sei),
  担当者名: g(h.rec, C.mei),
  役職: g(h.rec, C.title),
  部署: g(h.rec, C.dept),
  業種: g(h.rec, C.industry),
  従業員規模: g(h.rec, C.emp),
  都道府県: g(h.rec, C.pref),
  市区郡: g(h.rec, C.city),
  最終リードステージ: g(h.rec, C.stage),
  リード所有者: g(h.rec, C.owner),
  直近コール日時: g(h.rec, C.callAt),
  コール結果: g(h.rec, C.callResult),
  接続状況: g(h.rec, C.callConn),
  判定根拠: h.source,
  根拠テキスト: h.evidence.slice(0, 300),
  同一条件の重複リード数: String(dupCount.get(keyOf(h)) || 1),
  Webサイト: g(h.rec, C.web),
  メール: g(h.rec, C.mail),
  リードURL: g(h.rec, C.url),
  リードID: g(h.rec, C.id),
}));
fs.writeFileSync(OUT, '﻿' + toCsv(R_HEADERS, reviewRecs), 'utf8');

// ── 出力② BALES 266列（取込／タグ一括付与用・原本の値そのまま）──────
const outRecs = rows.map((h, i) => {
  const o = {};
  for (const k of HEADERS) o[k] = h.rec[k] == null ? '' : h.rec[k];
  o[C.no] = String(i + 1);
  return o;
});
fs.writeFileSync(BALES_OUT, '﻿' + toCsv(HEADERS, outRecs), 'utf8');

// ── サマリ ───────────────────────────────────────────────────────
const tally = (fn) => {
  const m = {};
  for (const h of rows) { const k = fn(h) || '(不明)'; m[k] = (m[k] || 0) + 1; }
  return m;
};
const byCat = tally((h) => h.cat);
const uniqCompanies = new Set(rows.map(ck)).size;
const noPhone = rows.filter((h) => !normPhone(h.phone)).length;

console.log(`\n─────────────────────────────────────────────`);
console.log(`[badnumber] BALES 架電不能（番号系）抽出`);
console.log(`─────────────────────────────────────────────`);
console.log(`  母集団                        ${records.length}リード`);
console.log(`  ① コール結果ピックリスト一致  ${stat.picklist}件`);
console.log(`  ② 自由記述から救済            ${stat.text}件${PICKLIST_ONLY ? `（--picklist-only のため ${stat.textSkipped}件 除外）` : ''}`);
console.log(`  重複統合                      ${merged}件${UNIQUE_COMPANY ? '（1社1行）' : '（同一社×同一番号×同一区分）'}`);
console.log(`\n[badnumber] 完成リスト ${rows.length}行 / ${uniqCompanies}社`);
for (const cat of CATEGORIES) {
  const n = byCat[cat] || 0;
  const pl = rows.filter((h) => h.cat === cat && h.source.startsWith('コール結果')).length;
  console.log(`  ${String(n).padStart(5)}件  ${cat}（ピックリスト${pl} / 自由記述${n - pl}）`);
}
console.log(`\n  電話番号が空欄の行            ${noPhone}件`);
console.log(`  都道府県 上位5                ${Object.entries(tally((h) => g(h.rec, C.pref))).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' / ')}`);
console.log(`  リードステージ 上位5          ${Object.entries(tally((h) => g(h.rec, C.stage))).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' / ')}`);
console.log(`\n[badnumber] out: ${path.relative(ROOT, OUT)}（${R_HEADERS.length}列・レビュー用）`);
console.log(`[badnumber] out: ${path.relative(ROOT, BALES_OUT)}（${HEADERS.length}列・BALES構造一致／取込用）`);
