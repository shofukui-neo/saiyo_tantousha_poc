'use strict';
/**
 * extract-zaitaku（在宅勤務メモのある企業を抽出）
 * =====================================================================
 * BALESCLOUD の既存リード（過去架電履歴つき）の自由記述列から
 * 「在宅」（在宅勤務・在宅対応 等）に言及のあるリードを抜き出し、
 * 会社名・担当者・該当スニペット付きでCSVに書き出す。
 *
 * ■ なぜBALESのみか
 *   セールスフォースMOCHICA参照エクスポートは自由記述の架電メモを持たない。
 *   在宅勤務の言及はすべてBALES側の履歴（活動メモ・コメント等）に由来する。
 *   （cf. [[kento-jiki-bales-only]]）
 *
 * 出力: data/bales-在宅勤務-企業.csv （1行=1リード、会社名でソート）
 *   node src/extract-zaitaku.js
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToRecords, toCsv } = require('./csv');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BALES = path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
const OUT = path.join(DATA, 'bales-在宅勤務-企業.csv');

// 履歴系の自由記述列（この中の「在宅」を拾う）
const FREE_FIELDS = [
  'カスタム情報：活動予定コメント',
  'カスタム情報：活動メモ',
  'カスタム情報：顧客の現状',
  'カスタム情報：顧客の課題感',
  'カスタム情報：ペンディング理由',
  'コメント1：内容',
  'コール結果1：コメント',
];

const ZAITAKU = /在宅/;
const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());

// 該当フィールドから「在宅」周辺のスニペットを1つ返す（前後30字）
function snippetOf(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const i = t.indexOf('在宅');
  if (i < 0) return '';
  return t.slice(Math.max(0, i - 30), Math.min(t.length, i + 30)).trim();
}

const { records } = rowsToRecords(parseCsv(fs.readFileSync(BALES, 'utf8')));

const rowsOut = [];
for (const r of records) {
  const hits = [];
  for (const f of FREE_FIELDS) {
    const v = g(r, f);
    if (ZAITAKU.test(v)) {
      hits.push({ field: f.replace('カスタム情報：', '').replace('コメント1：', 'コメント').replace('コール結果1：', 'コール'), snip: snippetOf(v) });
    }
  }
  if (!hits.length) continue;
  // 代表スニペット＝最初のヒット、根拠＝全ヒットを連結
  rowsOut.push({
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
    該当列: hits.map((h) => h.field).join(' / '),
    根拠: hits.map((h) => '[' + h.field + '] …' + h.snip + '…').join('  '),
    Webサイト: g(r, '会社情報：Webサイト'),
    リードURL: g(r, 'システム管理情報：リードURL'),
    リードID: g(r, 'システム管理情報：ID'),
  });
}

rowsOut.sort((a, b) => a.会社名.localeCompare(b.会社名, 'ja'));

const HEADERS = ['会社名', '電話', '担当者姓', '担当者名', '役職', '部署', 'リードステージ',
  'リード所有者', '従業員規模', '業種', '都道府県', '該当列', '根拠', 'Webサイト', 'リードURL', 'リードID'];
fs.writeFileSync(OUT, '﻿' + toCsv(HEADERS, rowsOut), 'utf8');

console.log('[extract-zaitaku] BALES総リード', records.length, '件');
console.log('  在宅勤務メモありリード:', rowsOut.length, '件');
console.log('  ユニーク会社名:', new Set(rowsOut.map((r) => r.会社名).filter(Boolean)).size, '社');
console.log('out:', path.relative(ROOT, OUT));
