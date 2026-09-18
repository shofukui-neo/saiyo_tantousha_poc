'use strict';
/**
 * インテント採点済みマスタ（leads-intent-wide.csv）から「架電する社」だけを抜く。
 *
 * 落とすもの（＝ここでいう「除外」）:
 *   1. MOCHCA適合判定「対象外」＝推奨アクション「対象外（架電しない）」
 *   2. インテント階層 C / D（残すのは A・B のみ）
 *   3. 既存被り「MOCHICA顧客」＝すでに自社顧客
 *   4. 電話番号が無い行（架電できない）
 *   ＋ 架電禁止リスト（data/ng-companies.txt）は toCsv のガードが自動で落とす
 *
 * 使い方: node src/build-intent-ab-list.js [--in <csv>] [--out <csv>]
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const IN = path.resolve(ROOT, getArg('in', 'data/leads-intent-wide.csv'));
const OUT = path.resolve(ROOT, getArg('out', 'data/leads-intent-ab-call.csv'));
const REPORT = path.resolve(ROOT, getArg('report', 'data/leads-intent-ab-call.md'));

const g = (r, k) => String(r && r[k] != null ? r[k] : '').trim();
const KEEP_TIER = ['A', 'B'];

const COLS = ['No', '総合優先度', 'インテント階層', 'インテントスコア', '企業名', '架電宛名', '採用担当者名',
  '電話番号', 'メール', '業種', '従業員数', '本社', '推奨アクション', '最有力シグナル', 'シグナル強度',
  'なぜ今', '推奨トーク', '予算状態', '検討時期', '予算トーク', '募集人数(最新卒年)', '昨年度入社数',
  '中途求人件数', 'MOCHCA適合判定', 'MOCHCA適合根拠', '要確認項目', 'ATS判定', 'ATS確度',
  '既存被り', '採用ページURL', '公式URL', 'corpID'];

function main() {
  const { records } = readCsv(fs.readFileSync(IN, 'utf8'));
  const drop = { 対象外: 0, 階層CD: 0, 既存顧客: 0, 電話なし: 0 };
  const kept = [];
  for (const r of records) {
    if (g(r, 'MOCHCA適合判定') === '対象外') { drop.対象外++; continue; }
    if (KEEP_TIER.indexOf(g(r, 'インテント階層')) < 0) { drop.階層CD++; continue; }
    if (g(r, '既存被り') === 'MOCHICA顧客') { drop.既存顧客++; continue; }
    if (!g(r, '電話番号')) { drop.電話なし++; continue; }
    kept.push(r);
  }
  kept.sort((a, b) => (parseFloat(b['総合優先度']) || 0) - (parseFloat(a['総合優先度']) || 0)
    || (parseFloat(b['インテントスコア']) || 0) - (parseFloat(a['インテントスコア']) || 0));
  kept.forEach((r, i) => { r.No = String(i + 1); });

  fs.writeFileSync(OUT, toCsv(COLS, kept), 'utf8');

  const count = (k) => {
    const m = {};
    for (const r of kept) { const v = g(r, k) || '(新規)'; m[v] = (m[v] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const L = ['# 架電リスト（除外・C/D階層を落とした版）', '',
    '生成: ' + new Date().toISOString().slice(0, 10) + '／母集団 ' + records.length + '社 → 出力 ' + kept.length + '社', '',
    '## 落とした内訳', '', '| 理由 | 社数 |', '|---|---|'];
  for (const kv of Object.entries(drop)) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '## インテント階層別', '', '| 階層 | 社数 |', '|---|---|');
  for (const kv of count('インテント階層')) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '## MOCHICA適合判定別', '', '| 判定 | 社数 |', '|---|---|');
  for (const kv of count('MOCHCA適合判定')) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '## 推奨アクション別', '', '| アクション | 社数 |', '|---|---|');
  for (const kv of count('推奨アクション')) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '## 既存被り別', '', '| 出所 | 社数 |', '|---|---|');
  for (const kv of count('既存被り')) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '## 上位30社', '', '| # | 総合 | 階層 | 企業名 | 電話 | 最有力シグナル |', '|---|---|---|---|---|---|');
  for (const r of kept.slice(0, 30)) {
    L.push('| ' + r.No + ' | ' + g(r, '総合優先度') + ' | ' + g(r, 'インテント階層') + ' | ' + g(r, '企業名')
      + ' | ' + g(r, '電話番号') + ' | ' + g(r, '最有力シグナル') + ' |');
  }
  fs.writeFileSync(REPORT, L.join('\n'), 'utf8');
  console.log('出力: ' + path.relative(ROOT, OUT) + ' ' + kept.length + '社');
  console.log('落とした: ' + JSON.stringify(drop));
}
main();
