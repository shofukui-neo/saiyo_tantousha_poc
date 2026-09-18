'use strict';
/**
 * ICP v5.1 の再採点（アポ期待度の充填）
 * ============================================================================
 * 統合マスタが持つ「アポ期待度」は v4 時代に保存された値で、21,779社のうち
 * 相当数が 100 に張り付いている。層2（インテント）の総合優先度は
 *   総合優先度 = (インテントスコア×0.65 + アポ期待度×0.35) × 予算係数
 * で計算されるため（intent/target-fit.js）、ここが古いままだと層1が効かない。
 *
 * このスクリプトは CSV を読んで scoreMochica（= ICP v5.1）で採点し直し、
 *   アポ期待度 / ICPスコア / ICPランク / MOCHICA適合 / 確信度 / 組織型 / ICP根拠
 * を書き戻す。ネットワークは使わない（CSVが持つ事実だけ）。
 *
 * 使い方:
 *   node src/rescore-icp-v5.js --in data/intent-pool.csv
 *   node src/rescore-icp-v5.js --in a.csv --out b.csv
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { scoreMochica } = require('./mochica-fit');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);

const IN = path.resolve(ROOT, getArg('in', 'data/intent-pool.csv'));
const OUT = path.resolve(ROOT, getArg('out', getArg('in', 'data/intent-pool.csv')));

const ADD = ['アポ期待度', 'ICPスコア', 'ICP優先度', 'ICPランク', 'MOCHICA適合', '確信度', '組織型', 'ICP根拠'];
const MARK = { '◎': 70, '○': 50 };

function main() {
  const { headers, records } = readCsv(fs.readFileSync(IN, 'utf8'));
  log(`読み込み ${records.length}社 ← ${path.relative(ROOT, IN)}`);
  const band = { '◎': 0, '○': 0, '△': 0, 除外: 0 };
  for (const rec of records) {
    const s = scoreMochica(rec);
    const mark = s.priority === '除外' ? '除外' : s.total >= MARK['◎'] ? '◎' : s.total >= MARK['○'] ? '○' : '△';
    band[mark]++;
    rec['アポ期待度'] = String(s.total);
    rec['ICPスコア'] = String(s.total);
    rec['ICP優先度'] = s.priority;
    rec['ICPランク'] = s.segment;
    rec['MOCHICA適合'] = mark;
    rec['確信度'] = String(s.confidence);
    rec['組織型'] = s.orgLabel;
    // 根拠は v5 の内訳（2段の期待値モデル）だけに絞る。v4遺産の次元は入れない。
    rec['ICP根拠'] = s.reasons.filter((r) => r.startsWith('V5:') || r.startsWith('NEG:')).join('／');
  }
  const cols = headers.slice();
  for (const c of ADD) if (!cols.includes(c)) cols.push(c);
  fs.writeFileSync(OUT, toCsv(cols, records), 'utf8');
  log(`帯: ◎70+ ${band['◎']}社／○50-69 ${band['○']}社／△-49 ${band['△']}社／除外 ${band['除外']}社`);
  log(`出力: ${path.relative(ROOT, OUT)}`);
}
main();
