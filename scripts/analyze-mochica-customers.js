'use strict';
/**
 * MOCHICA 既存顧客の傾向・属性を実データから定義するための分析スクリプト。
 *  - 既存顧客リスト(429社: 法人名/プラン/期間/Email)
 *  - Salesforce 全リード(86k: 会社名/電話/採用人数/状況/従業員数レンジ/メール/業種)
 * を突合し、勝ち顧客(=既存顧客 & コンバート済みリード)の firmographics を集計する。
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, normCompanyName } = require('../src/csv');

const DATA = path.join(__dirname, '..', 'data');
const CUST = path.join(DATA, 'MOCHICAの既存顧客リスト - mochica-companies-list.csv');
const SF = path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv');

function readText(p) { return fs.readFileSync(p, 'utf8'); }

// ---- 顧客リスト読み込み ----
const custRows = parseCsv(readText(CUST));
const custHead = custRows[0];
const custRecs = custRows.slice(1).map((r) => {
  const o = {}; custHead.forEach((h, i) => { o[String(h).trim()] = r[i] != null ? r[i] : ''; }); return o;
});

// ---- SFリード読み込み: ヘッダは10行目 ----
const sfRows = parseCsv(readText(SF));
// ヘッダ行を探す（"リードID18" を含む行）
let hIdx = sfRows.findIndex((r) => r.some((c) => String(c).includes('リードID18')));
const sfHead = sfRows[hIdx].map((c) => String(c).trim());
const sfRecs = sfRows.slice(hIdx + 1).map((r) => {
  const o = {}; sfHead.forEach((h, i) => { o[h] = r[i] != null ? r[i] : ''; }); return o;
});

const COL = {
  name: '会社名 / 取引先', phone: '電話', last: '姓',
  hire: '採用人数(選択リスト)', status: 'リード 状況',
  emp: '従業員数レンジ(ランスケ）', email: 'メール', industry: '業種',
};
// 列名ゆれ（全角括弧など）を吸収して実キーを解決
function resolveKey(want) {
  if (sfHead.includes(want)) return want;
  const w = want.replace(/[（）()]/g, '');
  const found = sfHead.find((h) => h.replace(/[（）()]/g, '') === w);
  return found || want;
}
Object.keys(COL).forEach((k) => { COL[k] = resolveKey(COL[k]); });

console.log('=== SF header ===');
console.log(JSON.stringify(sfHead));
console.log('resolved COL:', JSON.stringify(COL));
console.log('SF records:', sfRecs.length, '| Customer records:', custRecs.length);

// ---- 分布集計ヘルパ ----
function dist(records, key, mapFn) {
  const m = new Map();
  for (const r of records) {
    let v = mapFn ? mapFn(r) : r[key];
    v = (v == null || String(v).trim() === '') ? '(空白)' : String(v).trim();
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function printDist(title, arr, top = 30) {
  console.log('\n=== ' + title + ' ===');
  const total = arr.reduce((s, [, n]) => s + n, 0);
  arr.slice(0, top).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(6)}  ${(100 * n / total).toFixed(1).padStart(5)}%  ${k}`);
  });
  if (arr.length > top) console.log(`  ...(${arr.length - top} more)`);
}

// ---- SF全体の状況分布 ----
printDist('SF リード状況（全86k）', dist(sfRecs, COL.status), 40);

// コンバート済み（顧客化した）リードを抽出
const converted = sfRecs.filter((r) => /コンバート/.test(r[COL.status] || ''));
console.log('\nコンバート済みリード数:', converted.length);

printDist('コンバート顧客: 業種', dist(converted, COL.industry), 40);
printDist('コンバート顧客: 従業員数レンジ', dist(converted, COL.emp), 40);
printDist('コンバート顧客: 採用人数(選択リスト)', dist(converted, COL.hire), 40);

// ---- 既存顧客リストの属性 ----
printDist('既存顧客: 基本年間プラン', dist(custRecs, '基本年間プラン'), 20);
printDist('既存顧客: 現在利用プラン', dist(custRecs, '現在利用プラン'), 20);

// アップグレード有無
const upg = custRecs.filter((r) => String(r['アップグレードプラン①'] || '').trim() !== '').length;
console.log('\nアップグレード①あり:', upg, '/', custRecs.length);

// ---- 既存顧客 × SF 突合（社名正規化キー）----
const sfByName = new Map();
for (const r of sfRecs) {
  const k = normCompanyName(r[COL.name] || '');
  if (!k) continue;
  if (!sfByName.has(k)) sfByName.set(k, r); // 先勝ち
}
let matched = 0;
const custEnriched = [];
for (const c of custRecs) {
  const nm = c['法人名'] || '';
  if (!nm || nm === '削除') continue;
  const k = normCompanyName(nm);
  const hit = sfByName.get(k);
  if (hit) {
    matched++;
    custEnriched.push({ name: nm, industry: hit[COL.industry], emp: hit[COL.emp], hire: hit[COL.hire], plan: c['基本年間プラン'] });
  } else {
    custEnriched.push({ name: nm, industry: '', emp: '', hire: '', plan: c['基本年間プラン'] });
  }
}
console.log('\n既存顧客(有効) × SF名寄せ一致:', matched, '/', custEnriched.length);

printDist('既存顧客(突合成功のみ): 業種', dist(custEnriched.filter((r) => r.industry), 'industry'), 40);
printDist('既存顧客(突合成功のみ): 従業員数レンジ', dist(custEnriched.filter((r) => r.emp), 'emp'), 40);
printDist('既存顧客(突合成功のみ): 採用人数', dist(custEnriched.filter((r) => r.hire), 'hire'), 40);

// 保存: 突合結果
const outP = path.join(__dirname, '..', 'data', 'mochica-customer-enriched.json');
fs.writeFileSync(outP, JSON.stringify({ matched, total: custEnriched.length, records: custEnriched }, null, 2));
console.log('\nsaved:', outP);
