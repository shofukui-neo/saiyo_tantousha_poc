'use strict';
// アプローチ禁止企業の照合・除外。
//   禁止企業リスト(プレーンテキスト or CSV) と ターゲットリスト(CSV) を
//   「正規化社名(同名)」で突合し、一致した行をターゲットから除外する。
//
//   突合キーは csv.js の normCompanyName と同一 ＝ 法人格(株式会社/有限会社…)・
//   全半角・記号・空白の揺れを吸収した「素の社名」。法人番号は使わない
//   (禁止リストに番号が無く、ユーザ要望は「同名をはじく」ため)。
//
//   禁止リストの旧社名表記も展開してキー化する:
//     （旧：株式会社○○） / （旧社名：…） / ※旧社名：… / (旧：…)
//   → 現社名・旧社名のどちらがターゲットに載っていても捕捉する。
//
//   使い方:
//     node src/exclude-ng.js --ng data/ng-companies.txt --list leads-mochica-target.csv
//       → ドライラン。除外候補を leads-mochica-target.ng-filtered.csv と
//         leads-mochica-target.ng-excluded.csv に書き出すだけ(元ファイルは触らない)。
//     node src/exclude-ng.js --ng data/ng-companies.txt --list leads-mochica-target.csv --apply
//       → 元の --list を上書き(直前に .bak を作成)。除外明細も出力。

const fs = require('fs');
const path = require('path');
const { readCsv, toCsv, normCompanyName } = require('./csv');
// 禁止リストの索引化・突合ロジックは ng-index.js に集約（dedupe-approach.js と共用）。
const { buildNgIndex, ngHit } = require('./ng-index');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !String(v).startsWith('--')) ? v : true; }
  return def;
}

const NG_FILE  = getArg('ng', 'data/ng-companies.txt');
const LIST_CSV = getArg('list', 'leads-mochica-target.csv');
const APPLY    = !!getArg('apply', false);
const NAME_COL = getArg('name-col', '企業名');
// 既定: 法人格(株式会社等)の前後位置が逆のものは別法人とみなして残す。
// --ignore-corp-pos で従来どおり「素の社名一致」だけで除外。
const IGNORE_POS = !!getArg('ignore-corp-pos', false);

function resolveP(fp) { return path.isAbsolute(fp) ? fp : path.resolve(process.cwd(), fp); }
function mustRead(fp) {
  const abs = resolveP(fp);
  if (!fs.existsSync(abs)) { console.error(`✗ ファイルが見つかりません: ${abs}`); process.exit(1); }
  return fs.readFileSync(abs, 'utf8');
}

function writeBom(fp, headers, recs) {
  fs.writeFileSync(resolveP(fp), '﻿' + toCsv(headers, recs).replace(/\n/g, '\r\n'), 'utf8');
}

function main() {
  const ng = buildNgIndex(mustRead(NG_FILE));
  const list = readCsv(mustRead(LIST_CSV));
  if (!list.headers.includes(NAME_COL)) {
    console.error(`✗ ターゲットCSVに「${NAME_COL}」列がありません。--name-col で指定してください。`);
    process.exit(1);
  }

  const kept = [];
  const excluded = [];   // { ...rec, NG一致名 }
  const survivedByPos = []; // 正規化は一致したが前後逆で残した(参考表示)
  for (const rec of list.records) {
    const hit = ngHit(rec[NAME_COL], ng, { ignorePos: IGNORE_POS });
    if (hit) {
      excluded.push({ ...rec, NG一致名: hit.display });
    } else {
      kept.push(rec);
      if (!IGNORE_POS) {
        const key = normCompanyName(rec[NAME_COL]);
        if (key && ng.byKey.has(key)) survivedByPos.push([rec[NAME_COL], ng.byKey.get(key).display]);
      }
    }
  }

  const base = LIST_CSV.replace(/\.csv$/i, '');
  const outKept = `${base}.ng-filtered.csv`;
  const outExcl = `${base}.ng-excluded.csv`;

  writeBom(outKept, list.headers, kept);
  writeBom(outExcl, [...list.headers, 'NG一致名'], excluded);

  if (APPLY) {
    const bak = `${base}.bak.csv`;
    fs.copyFileSync(resolveP(LIST_CSV), resolveP(bak));
    writeBom(LIST_CSV, list.headers, kept);
  }

  console.log('==== アプローチ禁止企業 照合・除外 ====');
  console.log(`禁止リスト       : ${ng.rawNames} 名(現＋旧) → ユニーク正規化 ${ng.byKey.size} 件`);
  console.log(`ターゲット入力   : ${list.records.length} 件`);
  console.log(`禁止一致(除外)   : ${excluded.length} 件`);
  console.log(`残存(アプローチ可): ${kept.length} 件`);
  console.log('---- 出力 ----');
  console.log(`残存リスト : ${resolveP(outKept)}`);
  console.log(`除外明細   : ${resolveP(outExcl)}`);
  if (APPLY) {
    console.log(`元リスト上書: ${resolveP(LIST_CSV)} (バックアップ: ${resolveP(base + '.bak.csv')})`);
  } else {
    console.log('※ ドライラン。確定するには --apply を付けて再実行(元ファイルは未変更)。');
  }
  if (excluded.length) {
    console.log('---- 除外された企業(社名 / 一致した禁止表記) ----');
    for (const e of excluded) console.log(`  - ${e[NAME_COL]}  ←  ${e['NG一致名']}`);
  }
  if (survivedByPos.length) {
    console.log(`---- 社名は同じだが法人格が前後逆 → 別法人として残した(${survivedByPos.length}件) ----`);
    for (const [a, b] of survivedByPos) console.log(`  - 残: ${a}  ⇔  禁止: ${b}`);
  }
}

main();
