'use strict';
// 類似企業リストの母集団候補を評価: (A) SF未コンバートのリード, (B) 既存の名寄せ済み候補
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../src/csv');
const DATA = path.join(__dirname, '..', 'data');
const readText = (p) => fs.readFileSync(p, 'utf8');

// --- SF leads ---
const SF = path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv');
const sfRows = parseCsv(readText(SF));
const hIdx = sfRows.findIndex((r) => r.some((c) => String(c).includes('リードID18')));
const sfHead = sfRows[hIdx].map((c) => String(c).trim());
const idx = (name) => {
  let i = sfHead.indexOf(name);
  if (i >= 0) return i;
  const w = name.replace(/[（）()]/g, '');
  return sfHead.findIndex((h) => h.replace(/[（）()]/g, '') === w);
};
const cName = idx('会社名 / 取引先'), cPhone = idx('電話'), cHire = idx('採用人数(選択リスト)'),
  cStat = idx('リード 状況'), cEmp = idx('従業員数レンジ(ランスケ）'), cInd = idx('業種'), cMail = idx('メール');
const sf = sfRows.slice(hIdx + 1).map((r) => ({
  name: (r[cName] || '').trim(), phone: (r[cPhone] || '').trim(), hire: (r[cHire] || '').trim(),
  status: (r[cStat] || '').trim(), emp: (r[cEmp] || '').trim(), ind: (r[cInd] || '').trim(), mail: (r[cMail] || '').trim(),
})).filter((r) => r.name);

const nonConv = sf.filter((r) => !/コンバート/.test(r.status));
const fresh = sf.filter((r) => /新規/.test(r.status));
function pctFilled(arr, key) {
  const f = arr.filter((r) => r[key] && r[key] !== '不明').length;
  return `${f}/${arr.length} (${(100 * f / arr.length).toFixed(0)}%)`;
}
console.log('SF total(named):', sf.length);
console.log('非コンバート:', nonConv.length, '| 新規(01):', fresh.length);
console.log('--- 非コンバート firmographics 充足 ---');
console.log('  業種:', pctFilled(nonConv, 'ind'), '| 従業員:', pctFilled(nonConv, 'emp'), '| 採用人数:', pctFilled(nonConv, 'hire'), '| 電話:', pctFilled(nonConv, 'phone'));
console.log('--- 新規 firmographics 充足 ---');
console.log('  業種:', pctFilled(fresh, 'ind'), '| 従業員:', pctFilled(fresh, 'emp'), '| 採用人数:', pctFilled(fresh, 'hire'), '| 電話:', pctFilled(fresh, 'phone'));
// 3属性すべて揃う非コンバート
const rich = nonConv.filter((r) => r.ind && r.emp && r.emp !== '不明' && r.hire && r.hire !== '不明');
console.log('非コンバートで業種+従業員+採用人数すべて有り:', rich.length);
const richPhone = rich.filter((r) => r.phone);
console.log('  うち電話あり:', richPhone.length);

// --- (B) clean consolidated candidate list ---
const CL = path.join(__dirname, '..', 'leads-mochica-named-consolidated-clean.csv');
const clRows = parseCsv(readText(CL));
const clHead = clRows[0].map((c) => String(c).trim());
const ci = (n) => clHead.indexOf(n);
const cl = clRows.slice(1).map((r) => ({
  name: (r[ci('企業名')] || '').trim(), emp: (r[ci('従業員数')] || '').trim(),
  ind: (r[ci('業種')] || '').trim(), pref: (r[ci('都道府県')] || '').trim(),
  tel: (r[ci('電話番号')] || '').trim(), rep: (r[ci('採用担当者名')] || '').trim(),
}));
console.log('\n--- clean consolidated list ---');
console.log('rows:', cl.length);
console.log('  従業員数:', pctFilled(cl, 'emp'), '| 業種:', pctFilled(cl, 'ind'), '| 都道府県:', pctFilled(cl, 'pref'), '| 電話:', pctFilled(cl, 'tel'), '| 担当者名:', pctFilled(cl, 'rep'));
