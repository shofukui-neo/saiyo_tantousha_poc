'use strict';
// profile.js <input.csv>
// Decode a lead-list CSV and report: row count, detected name/contact/phone columns,
// and how empty the phone/web/address fields are (decides whether web lookup is needed).
const { parseCSV, readFile, findCol } = require('./lib');
const input = process.argv[2];
if (!input) { console.error('usage: node profile.js <input.csv>'); process.exit(1); }

const rows = parseCSV(readFile(input));
const H = rows[0];
const ci = {
  name: findCol(H, ['会社情報：会社名', '会社名', '企業名', '取引先名'], ['会社名', '企業名', '取引先']),
  phone: findCol(H, ['会社情報：電話', '電話', '電話番号', 'TEL'], ['電話', 'TEL', 'tel']),
  web: findCol(H, ['会社情報：Webサイト', 'Webサイト', 'URL', 'HP'], ['Web', 'URL', 'サイト']),
  pref: findCol(H, ['会社情報：住所：都道府県', '都道府県'], ['都道府県']),
  sei: findCol(H, ['担当者情報：姓', '姓'], []),
  mei: findCol(H, ['担当者情報：名', '名'], []),
  contact: findCol(H, ['担当者', '担当者名'], ['担当者']),
};
const data = rows.slice(1).filter(r => ci.name >= 0 && (r[ci.name] || '').trim());
const nonEmpty = (i) => i < 0 ? 0 : data.filter(r => (r[i] || '').trim()).length;

console.log('=== profile:', input, '===');
console.log('columns:', H.length, '| data rows:', data.length);
console.log('detected columns:');
for (const [k, v] of Object.entries(ci)) console.log('  ', k.padEnd(8), v >= 0 ? `#${v} "${H[v]}"` : '(not found)');
console.log('coverage (non-empty):');
console.log('   会社名 :', nonEmpty(ci.name), '/', data.length);
console.log('   電話   :', nonEmpty(ci.phone), '/', data.length);
console.log('   Web    :', nonEmpty(ci.web), '/', data.length);
console.log('   都道府県:', nonEmpty(ci.pref), '/', data.length);
const needWeb = nonEmpty(ci.phone) < data.length;
console.log('\n=> phone gaps:', data.length - nonEmpty(ci.phone), needWeb ? '(enrichment needed)' : '(already complete)');
console.log('sample:');
data.slice(0, 5).forEach(r => console.log('   ', (r[ci.name] || '').trim(), '| 担当:', ((ci.sei >= 0 ? r[ci.sei] : '') || '') + ((ci.mei >= 0 ? r[ci.mei] : '') || '') || (ci.contact >= 0 ? r[ci.contact] : '')));
