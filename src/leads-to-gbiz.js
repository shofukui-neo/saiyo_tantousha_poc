'use strict';
// leads-daihyou-1000.csv（実データ）→ sources/B-gbiz.csv（企業属性ソース）への射影。
// build-list の名寄せ統合で「代表者名/公式URL/従業員数/業種」を肉付けする土台にする。
//   node src/leads-to-gbiz.js --in leads-daihyou-1000.csv --out sources/B-gbiz.csv
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const IN = getArg('in', 'leads-daihyou-1000.csv');
const OUT = getArg('out', path.join('sources', 'B-gbiz.csv'));

const headers = ['企業名', '法人番号', '業種', '都道府県', '従業員数', '設立年', '補助金', '代表者名', '公式URL'];
const recs = readCsv(fs.readFileSync(path.resolve(IN), 'utf8')).records;
const out = recs.map((r) => ({
  '企業名': r['企業名'] || '', '法人番号': r['法人番号'] || '',
  '業種': r['業種'] || '', '都道府県': r['都道府県'] || '', '従業員数': r['従業員数'] || '',
  '設立年': r['設立年'] || '', '補助金': r['補助金'] || '', '代表者名': r['代表者名'] || '', '公式URL': r['公式URL'] || '',
}));
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(path.resolve(OUT), toCsv(headers, out));
console.log(`B-gbiz生成: ${out.length}社 → ${path.resolve(OUT)}`);
