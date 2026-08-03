'use strict';
/**
 * CLIスクリプト共通のミニヘルパ（引数/ログ/アトミック書込/JSON読み）。
 *
 * src/ の各バッチスクリプトが同じ4〜5行をコピーして持っていたものを1箇所に集約する。
 * ここは「純粋なユーティリティ」だけを置く。ドメインロジックは持ち込まない。
 */
const fs = require('fs');
const path = require('path');

/**
 * `--name value` 形式の引数を取る。値が省略された（次が別フラグ or 末尾）場合は true。
 * @param {string} name  先頭の `--` を除いたフラグ名
 * @param {*} def        未指定時の既定値
 * @param {string[]} [argv=process.argv]
 */
function getArg(name, def, argv) {
  const av = argv || process.argv;
  const i = av.indexOf('--' + name);
  if (i < 0) return def;
  const v = av[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

/** getArg の数値版（パース失敗時は def を返す）。 */
function getIntArg(name, def, argv) {
  const v = getArg(name, null, argv);
  if (v == null || v === true) return def;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : def;
}

/** HH:MM:SS 前置きのログ（長時間バッチの進捗が追えるように）。 */
function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

/**
 * アトミック書込（tmpへ書いてrename）。
 * 途中Ctrl-Cでも出力CSVが壊れないので、再開可能なバッチで使う。
 */
function atomicWrite(filePath, text) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, filePath);
}

/** JSONを読む。存在しない/壊れている場合は def（既定 null）。 */
function loadJson(filePath, def) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return def === undefined ? null : def; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** URL文字列 → ホスト名（www除去・小文字）。失敗時は空文字。 */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}

module.exports = { getArg, getIntArg, log, atomicWrite, loadJson, sleep, hostOf };
