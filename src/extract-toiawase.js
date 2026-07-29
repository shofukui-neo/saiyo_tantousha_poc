'use strict';
/**
 * extract-toiawase（コール結果「問い合わせ」のみのリードを抽出）
 * =====================================================================
 * BALESCLOUD の既存リード（過去架電履歴つき）から、架電の結果区分
 * 「コール結果1：結果 = 問い合わせ」だけを抜き出してCSVに書き出す。
 *
 * ■「問い合わせ」とは
 *   架電時にお断り／アポでもなく「問い合わせフォーム（またはHP）から
 *   連絡してほしい」と案内された結果区分。コメント例:
 *     「担当がリモート、必要があれば問い合わせからお願いします」
 *     「HPからといあわせて」「問合せフォームからお願いと」
 *   → 受付ブロックや門前払いとは異なり、窓口が明示された再アプローチ候補。
 *
 * ■ なぜBALESのみか
 *   セールスフォースMOCHICA参照エクスポートは架電結果区分を持たない。
 *   コール結果はすべてBALES側の履歴に由来する。（cf. [[kento-jiki-bales-only]]）
 *
 * 出力: data/bales-問い合わせのみ.csv （1行=1リード、会社名でソート）
 *   node src/extract-toiawase.js
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToRecords, toCsv } = require('./csv');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BALES = path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
const OUT = path.join(DATA, 'bales-問い合わせのみ.csv');

const g = (r, k) => (r[k] == null ? '' : String(r[k]).trim());

const { records } = rowsToRecords(parseCsv(fs.readFileSync(BALES, 'utf8')));

const rowsOut = [];
for (const r of records) {
  if (g(r, 'コール結果1：結果') !== '問い合わせ') continue; // 結果区分＝問い合わせ のみ
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
    コール日時: g(r, 'コール結果1：開始日時'),
    コールコメント: g(r, 'コール結果1：コメント').replace(/\s+/g, ' '),
    Webサイト: g(r, '会社情報：Webサイト'),
    リードURL: g(r, 'システム管理情報：リードURL'),
    リードID: g(r, 'システム管理情報：ID'),
  });
}

rowsOut.sort((a, b) => a.会社名.localeCompare(b.会社名, 'ja'));

const HEADERS = ['会社名', '電話', '担当者姓', '担当者名', '役職', '部署', 'リードステージ',
  'リード所有者', '従業員規模', '業種', '都道府県', 'コール日時', 'コールコメント',
  'Webサイト', 'リードURL', 'リードID'];
fs.writeFileSync(OUT, '﻿' + toCsv(HEADERS, rowsOut), 'utf8');

console.log('[extract-toiawase] BALES総リード', records.length, '件');
console.log('  コール結果「問い合わせ」リード:', rowsOut.length, '件');
console.log('  ユニーク会社名:', new Set(rowsOut.map((r) => r.会社名).filter(Boolean)).size, '社');
console.log('out:', path.relative(ROOT, OUT));
