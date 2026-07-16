'use strict';
/**
 * extract-kento-jiki（検討時期＝○○月 抽出・月別まとめ）
 * =====================================================================
 * BALESCLOUD の既存リード（過去架電履歴つき）から「検討時期として○○月に
 * 言及があるリード」だけを抜き出し、各月（1〜12月）にまとめ直す。
 *
 * ■ なぜBALESのみか
 *   セールスフォースMOCHICA参照エクスポート（13列）は
 *   リードID/会社名/電話/姓/採用人数/リード状況/従業員数/セミナー項目/メール/業種
 *   のみで、架電メモ・活動履歴・検討時期といった自由記述列を一切含まない。
 *   よって「○○月＋検討時期の言及」はすべてBALES側の履歴に由来する。
 *
 * ■ 抽出区分（confidenceの高い順）
 *   1) 構造化 … カスタム情報：検討開始時期 が "N月"（BALESのピックリスト。最も確実）
 *   2) 自由記述 … 検討開始時期が空で、履歴の自由記述に「検討系キーワード」と
 *                 「N月」が近接（前後22文字以内）して現れるもの。
 *   同一リードの二重計上を避けるため、構造化があるリードは自由記述抽出しない。
 *   自由記述リードは複数月に言及しうるため、(リード×月) で行を分ける。
 *
 * 出力:
 *   data/bales-検討時期-月別.csv  … 1行=(リード×検討月)。検討月でソート。
 *   標準出力に月別サマリを表示。
 *
 *   node src/extract-kento-jiki.js
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToRecords, toCsv } = require('./csv');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BALES = path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
const OUT = path.join(DATA, 'bales-検討時期-月別.csv');

// 履歴系の自由記述列（この中に「検討×N月」が近接すれば拾う）
const FREE_FIELDS = [
  'カスタム情報：活動予定コメント',
  'カスタム情報：活動メモ',
  'カスタム情報：顧客の現状',
  'カスタム情報：顧客の課題感',
  'カスタム情報：ペンディング理由',
  'コメント1：内容',
  'コール結果1：コメント',
];

// 「検討時期」を示す文脈キーワード（月の近くにこれがあれば検討時期の言及とみなす）
const CONSIDER = /検討|再検討|導入|更新|稟議|予算化|動き出し|動き始め|始動|再電|再架電|リサイクル|追客|アプローチ|商談化|決裁|見直し|切り替え|切替|再連絡|フォロー|入替|入れ替え|リプレイス|利用時期|開始時期/;

const z2h = (s) => String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

// テキストから「検討文脈に近接するN月」を {month, snippet} で返す
function findMonthMentions(text) {
  const t = z2h(text).replace(/\s+/g, ' ');
  const out = [];
  const re = /([0-9]{1,2})\s*月/g;
  let m;
  while ((m = re.exec(t))) {
    const mon = parseInt(m[1], 10);
    if (mon < 1 || mon > 12) continue;
    const s = Math.max(0, m.index - 22);
    const e = Math.min(t.length, m.index + m[0].length + 22);
    const win = t.slice(s, e);
    if (CONSIDER.test(win)) out.push({ month: mon, snippet: win.trim() });
  }
  return out;
}

const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());

const { records } = rowsToRecords(parseCsv(fs.readFileSync(BALES, 'utf8')));

// 出力行の共通整形
function baseCols(r) {
  return {
    会社名: g(r, '会社情報：会社名'),
    電話: g(r, '会社情報：電話') || g(r, '担当者情報：電話'),
    担当者姓: g(r, '担当者情報：姓'),
    担当者名: g(r, '担当者情報：名'),
    役職: g(r, '担当者情報：役職'),
    部署: g(r, '担当者情報：部署'),
    リードステージ: g(r, 'リード関連情報：最終リードステージ'),
    リード所有者: g(r, 'リード関連情報：リード所有者'),
    従業員規模: g(r, '会社情報：従業員規模'),
    業種: g(r, '会社情報：業種'),
    都道府県: g(r, '会社情報：住所：都道府県'),
    'Webサイト': g(r, '会社情報：Webサイト'),
    リードURL: g(r, 'システム管理情報：リードURL'),
    リードID: g(r, 'システム管理情報：ID'),
  };
}

const rowsOut = [];
const stat = {}; // month -> {struct, free}
for (let i = 1; i <= 12; i++) stat[i] = { struct: 0, free: 0 };

for (const r of records) {
  const sv = g(r, 'カスタム情報：検討開始時期');
  const mStruct = sv.match(/^([0-9]{1,2})月$/);
  if (mStruct) {
    const mon = parseInt(mStruct[1], 10);
    stat[mon].struct++;
    rowsOut.push({ 検討月: mon + '月', 抽出区分: '構造化', 根拠: '検討開始時期=' + sv, ...baseCols(r) });
    continue; // 構造化があるリードは自由記述抽出しない（二重計上防止）
  }
  // 自由記述スキャン（リード内で月ごとに1回、代表スニペットを採用）
  const byMonth = new Map();
  for (const f of FREE_FIELDS) {
    for (const hit of findMonthMentions(r[f])) {
      if (!byMonth.has(hit.month)) byMonth.set(hit.month, { field: f, snippet: hit.snippet });
    }
  }
  for (const [mon, info] of byMonth) {
    stat[mon].free++;
    rowsOut.push({
      検討月: mon + '月',
      抽出区分: '自由記述',
      根拠: '[' + info.field.replace('カスタム情報：', '').replace('コール結果1：', 'コール').replace('コメント1：', 'コメント') + '] …' + info.snippet + '…',
      ...baseCols(r),
    });
  }
}

// 検討月→抽出区分→会社名 でソート
const monthNum = (s) => parseInt(String(s).replace('月', ''), 10);
rowsOut.sort((a, b) =>
  monthNum(a.検討月) - monthNum(b.検討月) ||
  (a.抽出区分 === b.抽出区分 ? 0 : a.抽出区分 === '構造化' ? -1 : 1) ||
  a.会社名.localeCompare(b.会社名, 'ja')
);

const HEADERS = ['検討月', '抽出区分', '会社名', '電話', '担当者姓', '担当者名', '役職', '部署',
  'リードステージ', 'リード所有者', '従業員規模', '業種', '都道府県', '根拠', 'Webサイト', 'リードURL', 'リードID'];
fs.writeFileSync(OUT, '﻿' + toCsv(HEADERS, rowsOut), 'utf8');

// ── サマリ出力 ──────────────────────────────────────────────
const totStruct = Object.values(stat).reduce((s, v) => s + v.struct, 0);
const totFree = Object.values(stat).reduce((s, v) => s + v.free, 0);
console.log('[extract-kento-jiki] BALES総リード', records.length, '件');
console.log('  ※SFエクスポートは自由記述履歴を持たないため対象外（月言及ゼロ）');
console.log('検討月 | 構造化 | 自由記述 | 合計');
console.log('-------|-------|---------|-----');
for (let i = 1; i <= 12; i++) {
  const s = stat[i];
  console.log(
    String(i + '月').padStart(4) + '   | ' +
    String(s.struct).padStart(4) + '  | ' +
    String(s.free).padStart(5) + '   | ' +
    String(s.struct + s.free).padStart(4)
  );
}
console.log('-------|-------|---------|-----');
console.log(' 合計  | ' + String(totStruct).padStart(4) + '  | ' + String(totFree).padStart(5) + '   | ' + String(totStruct + totFree).padStart(4) + '  （出力行数）');
console.log('out:', path.relative(ROOT, OUT));
