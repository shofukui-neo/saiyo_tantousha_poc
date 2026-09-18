'use strict';
/**
 * 総合優先度リストを「完全新規」と「既存接触あり」に割る
 * ============================================================================
 * build-icp-intent-all.js の出力は統合マスタ全社が入っているので、大半が
 * すでにどこかで触っている社である（実測: 総合50以上の95%）。
 * 「今週架ける先」を出すには、そこを割らないと意味がない。
 *
 * 判定は CSV の `既存被り` 列を信じない（統合時点の値で、層が欠けている）。
 * exclusion-index.js の4層（MOCHICA顧客／BALES既存／SFリード／納品済み台帳）を
 * その場で組み直して突合する。名寄せは company-match の表記ゆれ・長音・農協ルール込み。
 *
 * 使い方:
 *   node src/split-icp-intent-fresh.js
 *   node src/split-icp-intent-fresh.js --min 50
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { buildExclusionIndex } = require('./exclusion-index');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

const IN = path.resolve(ROOT, getArg('in', 'data/leads-icp-intent-all.csv'));
const FRESH = path.resolve(ROOT, getArg('fresh', 'data/leads-icp-intent-fresh.csv'));
const KNOWN = path.resolve(ROOT, getArg('known', 'data/leads-icp-intent-known.csv'));
const REPORT = path.resolve(ROOT, getArg('report', 'data/icp-intent-fresh.md'));
const MIN = parseFloat(getArg('min', '0'));

const g = (r, k) => String(r && r[k] != null ? r[k] : '').trim();

const COLS = ['No', '総合優先度', '総合ランク', '企業名', '架電宛名', '採用担当者名', '電話番号', '業種', '従業員数',
  '本社', 'ICPスコア(充填後)', 'ICP組織型', 'インテントスコア', 'インテント階層', '最有力シグナル', 'なぜ今',
  '推奨アクション', '推奨トーク', '募集人数(最新卒年)', '昨年度入社数', '予算状態', 'MOCHCA適合判定', '要確認項目',
  '接触状況', '接触根拠', '採用ページURL'];

function main() {
  const { records } = readCsv(fs.readFileSync(IN, 'utf8'));
  log('読み込み ' + records.length + '社 ← ' + path.relative(ROOT, IN));

  const ex = buildExclusionIndex({ masters: true, ledger: true });
  log('除外索引 ' + ex.idx.size + '社（' + ex.layers.join('+') + '）');

  const fresh = []; const known = [];
  for (const r of records) {
    if ((parseFloat(r['総合優先度']) || 0) < MIN) continue;
    const name = g(r, '企業名');
    const hitIdx = ex.idx.has(name);
    const detail = hitIdx && ex.idx.matchDetail ? ex.idx.matchDetail(name) : null;
    // CSVが持っている 既存被り も併記する（層が欠けていても情報としては残す）
    const csvDup = g(r, '既存被り');
    const hit = hitIdx || !!csvDup;
    r['接触状況'] = hit ? '既存接触あり' : '完全新規';
    r['接触根拠'] = [
      hitIdx ? '除外索引:' + (detail && detail.layer ? detail.layer : 'hit') : '',
      csvDup ? 'CSV既存被り:' + csvDup : '',
    ].filter(Boolean).join('／') || '4層いずれにも無し';
    (hit ? known : fresh).push(r);
  }

  fresh.forEach((r, i) => { r.No = String(i + 1); });
  known.forEach((r, i) => { r.No = String(i + 1); });
  fs.writeFileSync(FRESH, toCsv(COLS, fresh), 'utf8');
  fs.writeFileSync(KNOWN, toCsv(COLS, known), 'utf8');
  log('完全新規: ' + fresh.length + '社 → ' + path.relative(ROOT, FRESH));
  log('既存接触あり: ' + known.length + '社 → ' + path.relative(ROOT, KNOWN));

  const band = (list) => {
    const b = { S: 0, A: 0, B: 0, C: 0, 除外: 0 };
    for (const r of list) b[r['総合ランク']] = (b[r['総合ランク']] || 0) + 1;
    return b;
  };
  const bf = band(fresh); const bk = band(known);
  const L = [];
  L.push('# 総合優先度リストの 完全新規 / 既存接触 の割り', '');
  L.push('生成: ' + new Date().toISOString().slice(0, 10) + '／母集団 ' + (fresh.length + known.length) + '社', '');
  L.push('判定は `既存被り` 列ではなく exclusion-index の4層（MOCHICA顧客／BALES既存／SFリード／納品済み台帳 '
    + ex.idx.size + '社）をその場で突合した結果。', '');
  L.push('| ランク | 完全新規 | 既存接触あり |', '|---|---|---|');
  for (const k of ['S', 'A', 'B', 'C', '除外']) L.push('| ' + k + ' | ' + (bf[k] || 0) + ' | ' + (bk[k] || 0) + ' |');
  L.push('| **計** | **' + fresh.length + '** | **' + known.length + '** |', '');
  L.push('## 完全新規の上位30社', '');
  L.push('| # | 総合 | ランク | 企業名 | 電話 | ICP | インテント | 最有力シグナル |', '|---|---|---|---|---|---|---|---|');
  for (const r of fresh.slice(0, 30)) {
    L.push('| ' + r.No + ' | ' + r['総合優先度'] + ' | ' + r['総合ランク'] + ' | ' + g(r, '企業名')
      + ' | ' + (g(r, '電話番号') ? 'あり' : 'なし') + ' | ' + r['ICPスコア(充填後)']
      + ' | ' + g(r, 'インテントスコア') + ' | ' + g(r, '最有力シグナル') + ' |');
  }
  L.push('', '## 注意', '');
  L.push('- **架電禁止リスト（`data/ng-companies.txt`）はこの割りに入っていない**。別系統（ng-guard）で、'
    + '現在ファイルが無いためガードが素通しになっている。納品前に `npm run ng:check` を通すこと。');
  L.push('- 「既存接触あり」は捨てる相手ではない。SF/BALESに履歴がある＝再アプローチの材料がある側。');
  fs.writeFileSync(REPORT, L.join('\n'), 'utf8');
  log('レポート: ' + path.relative(ROOT, REPORT));
}
main();
