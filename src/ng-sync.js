'use strict';
// 架電禁止リストの取込・更新（正リスト data/ng-companies.txt を作る）。
//   入力は CSV（社名列を自動判定／--col で指定）でも、1行1社名のテキストでも可。
//   既存の正リストとマージ（追記）し、正規化社名で重複排除して書き戻す。
//
//   使い方:
//     node src/ng-sync.js "<source.csv>"            … マージ取込（既定）
//     node src/ng-sync.js "<source.csv>" --replace  … 既存を捨てて置き換え
//     node src/ng-sync.js --stat                    … 現在の正リストの状態表示
//
//   取込時にノイズ行（空・数字のみ・1文字）は落とし、末尾に落とした内訳を表示する。
//   取込後は `npm run ng:sweep` で既存成果物を一括で掃除すること。

const fs = require('fs');
const path = require('path');
const { parseCsv, rowsToRecords, normCompanyName } = require('./csv');
const { buildNgIndex } = require('./ng-index');
const guard = require('./ng-guard');

const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes('--' + f);
const val = (f, d) => { const i = ARGV.indexOf('--' + f); return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d; };
const SRC = ARGV.filter((a) => !a.startsWith('--'))[0];
const COL = val('col', '');
const OUT = path.resolve(val('out', guard.NG_FILE));
const REPLACE = has('replace');

function readSourceNames(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/\.csv$/i.test(file)) return text.split(/\r?\n/);
  const { headers, records } = rowsToRecords(parseCsv(text));
  const col = COL || headers.find((h) => guard.NAME_COL_RE.test(h)) || headers[0];
  if (!headers.includes(col)) { console.error(`✗ 列「${col}」がありません（列: ${headers.join(' / ')}）`); process.exit(1); }
  console.log(`  取込列: ${col}`);
  // セル内改行は別名として展開（"A\nB" のような2社1セルを取りこぼさない）
  return records.flatMap((r) => String(r[col] || '').split(/\r?\n/));
}

function main() {
  if (has('stat') || !SRC) {
    const idx = guard.loadNg();
    console.log(`架電禁止リスト: ${guard.NG_FILE}`);
    console.log(`  登録社名(正規化後ユニーク): ${idx.byKey.size} 件 / 生の社名表記: ${idx.rawNames} 件`);
    if (!SRC) console.log('\n使い方: node src/ng-sync.js "<禁止リスト.csv>" [--replace] [--col 列名] [--out path]');
    return;
  }
  const src = path.resolve(SRC);
  if (!fs.existsSync(src)) { console.error(`✗ 入力が見つかりません: ${src}`); process.exit(1); }

  const before = (!REPLACE && fs.existsSync(OUT)) ? fs.readFileSync(OUT, 'utf8').split(/\r?\n/) : [];
  const beforeKeys = buildNgIndex(before.join('\n')).byKey.size;

  const raw = readSourceNames(src);
  const dropped = { empty: 0, digits: 0 };
  const short1 = [];   // 正規化1文字（株式会社健 等の実在社名）— 落とさず参考表示
  const seen = new Map();     // 正規化キー -> 表示名（先勝ち）
  const push = (nm) => {
    const s = String(nm || '').replace(/^﻿/, '').replace(/^"+|"+$/g, '').trim();
    if (!s) { dropped.empty++; return; }
    const key = normCompanyName(s);
    if (!key) { dropped.empty++; return; }
    if (/^\d+$/.test(key)) { dropped.digits++; return; }        // 「2020」「4」等の壊れ行
    if (key.length < 2) short1.push(s);   // 「株式会社健」等。同名完全一致でしか当たらないので採る
    if (!seen.has(key)) seen.set(key, s);
  };
  for (const nm of before) push(nm);
  const beforeCount = seen.size;
  for (const nm of raw) push(nm);

  const names = [...seen.values()];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, names.join('\n') + '\n', 'utf8');

  const idx = buildNgIndex(names.join('\n'));
  console.log(`✓ 架電禁止リストを更新: ${OUT}`);
  console.log(`  入力: ${src}（生 ${raw.length} 行）`);
  console.log(`  登録: ${names.length} 社名（${REPLACE ? '置換' : `既存 ${beforeCount} → 追加 ${names.length - beforeCount}`}）`);
  console.log(`  突合キー(正規化・旧社名展開込み): ${idx.byKey.size} 件`);
  console.log(`  取込除外: 空/正規化不能 ${dropped.empty} / 数字のみ(壊れ行) ${dropped.digits}`);
  if (short1.length) console.log(`  ※ 正規化1文字の社名 ${short1.length} 件も登録（同名完全一致のみヒット）: ${[...new Set(short1)].join(' / ')}`);
  if (!REPLACE) console.log(`  （参考）取込前の突合キー: ${beforeKeys} 件`);
  console.log('\n次: npm run ng:sweep   ← 既存成果物から禁止企業を一括削除');
}

main();
