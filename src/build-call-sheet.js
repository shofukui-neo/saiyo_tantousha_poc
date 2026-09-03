'use strict';
/**
 * 架電シート生成（スコア付きリスト → 架電に必要な最低情報のみ）
 * =====================================================================
 * src/score-sf-leads.js が出す30列のスコア付きCSVは、判定根拠・出所・突合の
 * 監査情報まで持つため架電中に読めない。ここでは「受話器を上げてから
 * 切るまでに実際に使う列」だけへ落とす。
 *
 *   node src/build-call-sheet.js [--in data/leads-sf-scored-YYYYMMDD.csv] [--out ...]
 *   npm run call-sheet
 *
 * 落とす行: 判定=除外（次アクション=架電しない）／電話番号なし／会社名+電話の重複
 * 落とす列: 確信度・原文・突合キー・各出所・SF突合/タグ・除外理由・根拠 など監査用
 * 並び順  : 判定(A→D) → スコア降順（＝上から順に架電すればよい）
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// 既定は data/leads-sf-scored-*.csv の最新
function latestScored() {
  const dir = path.join(ROOT, 'data');
  const files = fs.readdirSync(dir).filter((f) => /^leads-sf-scored-\d+\.csv$/.test(f)).sort();
  if (!files.length) throw new Error('data/leads-sf-scored-*.csv が見つかりません');
  return path.join(dir, files[files.length - 1]);
}

const inFile = path.resolve(ROOT, arg('--in', latestScored()));
const stamp = (path.basename(inFile).match(/(\d{8})/) || [, ''])[1] || '';
const outFile = path.resolve(ROOT, arg('--out', path.join(ROOT, 'data', `leads-sf-call-${stamp || 'latest'}.csv`)));

const OUT_COLS = ['優先', '会社名', '電話番号', '担当者名', '業種', '従業員数', '新卒採用人数',
  '提案プラン', '前回接触', '失注理由', '検討時期', '注意'];
const RANK = { A: 0, B: 1, C: 2, D: 3 };

const g = (r, k) => String(r[k] || '').trim();

// 注意欄：架電中に効く警告だけ残す（突合キー整形などの内部処理ログは捨てる）
function callerNotes(r) {
  const out = [];
  const ats = g(r, '利用中ATS');
  if (ats && ats !== '無し') out.push(`利用中ATS:${ats}`);
  for (const p of g(r, '注意').split(' / ')) {
    const t = p.trim();
    if (!t || t.startsWith('突合キーを整形')) continue;
    out.push(t);
  }
  return out.join(' / ');
}

const { records } = readCsv(fs.readFileSync(inFile, 'utf8'));
const seen = new Set();
const dropped = { excluded: 0, noPhone: 0, dup: 0 };

const rows = records
  .filter((r) => {
    if (g(r, '判定') === '除外' || g(r, '次アクション') === '架電しない') { dropped.excluded++; return false; }
    if (!g(r, '電話番号')) { dropped.noPhone++; return false; }
    const k = `${g(r, '会社名')}|${g(r, '電話番号')}`;
    if (seen.has(k)) { dropped.dup++; return false; }
    seen.add(k);
    return true;
  })
  .sort((a, b) => (RANK[g(a, '判定')] ?? 9) - (RANK[g(b, '判定')] ?? 9)
    || Number(g(b, 'スコア') || 0) - Number(g(a, 'スコア') || 0)
    || g(a, '会社名').localeCompare(g(b, '会社名'), 'ja'))
  .map((r) => ({
    優先: g(r, '判定'),
    会社名: g(r, '会社名'),
    電話番号: g(r, '電話番号'),
    担当者名: g(r, '担当者名'),
    業種: g(r, '業種'),
    従業員数: g(r, '従業員数'),
    新卒採用人数: g(r, '新卒採用人数'),
    提案プラン: g(r, '提案プラン'),
    前回接触: g(r, 'BALES最終ステージ'),
    失注理由: g(r, '失注理由'),
    検討時期: g(r, '検討開始時期'),
    注意: callerNotes(r),
  }));

fs.writeFileSync(outFile, '﻿' + toCsv(OUT_COLS, rows), 'utf8');

const byRank = OUT_COLS && ['A', 'B', 'C', 'D'].map((k) => `${k}:${rows.filter((r) => r.優先 === k).length}`).join(' / ');
console.log(`[call-sheet] 入力 ${path.relative(ROOT, inFile)} … ${records.length}件`);
console.log(`[call-sheet] 除外 架電しない:${dropped.excluded} / 電話なし:${dropped.noPhone} / 重複:${dropped.dup}`);
console.log(`[call-sheet] 出力 ${path.relative(ROOT, outFile)} … ${rows.length}件（${byRank}）× ${OUT_COLS.length}列`);
