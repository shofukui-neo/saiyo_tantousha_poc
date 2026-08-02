'use strict';
/**
 * select-bales-top50
 * =====================================================================
 * 「最高品質・担当者名判明」上位N件を厳選する。leads-named-mochica-max.csv
 * （担当者名判明×ICP適合×既存非重複）から、BALESCLOUD＝架電ツールで
 * 即アクション可能な最高品質だけを抽出する。
 *
 * 品質定義（この順で降順ソート）:
 *   1) 担当者確度  … 氏名の信頼度（最重要。名前が正しくなければ架電価値なし）
 *   2) アポ期待度  … MOCHICA実証ICP適合スコア
 *   3) 確信度      … 総合確信度
 * 前提フィルタ:
 *   - 電話番号あり（BALESは架電クラウド。到達性なきリードは除外）
 *   - 担当者確度 >= 0.85（上位帯のみ）
 *
 * 出力は max リストと同一スキーマの中間CSV。続けて format-bales.js に通し
 * BALESCLOUD 266列構造へ変換する。
 *
 *   node src/select-bales-top50.js [--n 50] [--minconf 0.85]
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { loadLedger, isDelivered, DEFAULT_LEDGER } = require('./delivered-ledger');
const { createMatchIndex } = require('./company-match');

const DATA = path.join(__dirname, '..', 'data');
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const N = parseInt(getArg('--n', '50'), 10);
const MINCONF = parseFloat(getArg('--minconf', '0.85'));
const LEDGER = path.resolve(getArg('--ledger', DEFAULT_LEDGER));
const DEDUPE_HISTORY = !args.includes('--no-dedupe-history'); // 既定ON：過去作成企業を母集団から除外
const IN = path.join(DATA, 'leads-named-mochica-max.csv');
const OUT = path.join(DATA, '_bales-top50-selected.csv');

const num = (v) => parseFloat(String(v || '').replace(/[^0-9.]/g, '')) || 0;

// 氏名でない抽出エラー（役割語・状態語・断片）を弾く。担当者確度が高くても
// これらは架電時に呼びかけられないため「最高品質」から除外する。
const BAD_NAME = /(予定|未定|担当|採用|応募|窓口|人事|総務|募集|新卒|各位|御中|ご担当|金額|職種|係$|部$|課$|室$)/;
function isRealName(v) {
  const n = String(v || '').trim().replace(/\s+/g, '');
  if (n.length < 2) return false;
  if (BAD_NAME.test(n)) return false;
  return true;
}

const { records } = readCsv(fs.readFileSync(IN, 'utf8'));

// 過去作成企業（納品済み台帳）を母集団から除外 → top N を「新規のみ」から選ぶ
const ledgerIdx = DEDUPE_HISTORY ? loadLedger(LEDGER) : createMatchIndex();
let histDupe = 0;

const pool = records.filter((r) => {
  if ((r['電話番号'] || '').trim() && isRealName(r['採用担当者名']) && num(r['担当者確度']) >= MINCONF) {
    if (DEDUPE_HISTORY && isDelivered(ledgerIdx, r)) { histDupe += 1; return false; }
    return true;
  }
  return false;
});

pool.sort((a, b) =>
  num(b['担当者確度']) - num(a['担当者確度']) ||
  num(b['アポ期待度']) - num(a['アポ期待度']) ||
  num(b['確信度']) - num(a['確信度'])
);

const top = pool.slice(0, N);
const HEADERS = Object.keys(records[0]);
fs.writeFileSync(OUT, toCsv(HEADERS, top), 'utf8');

console.log(`[select] 母集団 ${records.length}件 → 品質フィルタ通過 ${pool.length}件 → 上位 ${top.length}件`);
if (DEDUPE_HISTORY) console.log(`[select] 過去作成企業を除外: ${histDupe}件（台帳 ${ledgerIdx.size}社と突合）`);
console.log(`[select] 担当者確度 ${num(top[0]['担当者確度'])}〜${num(top[top.length - 1]['担当者確度'])}｜アポ期待度 ${num(top[0]['アポ期待度'])}〜${num(top[top.length - 1]['アポ期待度'])}`);
console.log(`[select] 全件電話あり=${top.every((r) => (r['電話番号'] || '').trim())}`);
console.log(`[select] out: ${path.relative(path.join(__dirname, '..'), OUT)}`);
