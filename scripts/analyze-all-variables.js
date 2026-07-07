'use strict';
/**
 * 拡充済み既存顧客(429社)の「あらゆる変数」を横断分析。
 *  - 各変数の分布
 *  - クロス集計（プラン×規模、業種×規模、チャネル×セグメント 等）
 *  - firmographic変数は SF全リードの実成約リフトと接続
 * 出力: コンソール + data/mochica-variable-analysis.json
 */
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const cust = JSON.parse(fs.readFileSync(path.join(DATA, 'mochica-customers-enriched-full.json'), 'utf8'));
const rates = JSON.parse(fs.readFileSync(path.join(DATA, 'empirical-icp-rates.json'), 'utf8'));
const N = cust.length;

function dist(key, opt = {}) {
  const m = new Map();
  for (const r of cust) {
    let v = r[key]; v = (v == null || String(v).trim() === '') ? (opt.keepBlank ? '(空白)' : null) : String(v).trim();
    if (v == null) continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function show(title, key, opt = {}) {
  console.log('\n=== ' + title + ' ===');
  const arr = dist(key, opt);
  const tot = arr.reduce((s, [, n]) => s + n, 0);
  arr.slice(0, opt.top || 20).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)} ${(100 * n / tot).toFixed(1).padStart(5)}%  ${k}`));
  const known = arr.reduce((s, [, n]) => s + n, 0);
  console.log(`  （有効回答 ${known}/${N} = ${(100 * known / N).toFixed(0)}%）`);
  return arr;
}

// 実成約リフト参照
const liftOf = (which, bucket) => { const a = rates[which].find((x) => x.bucket === bucket); return a ? (a.rate / rates.overall) : null; };

console.log('顧客総数:', N);

// ---- 1. firmographics（成約リフト付き）----
console.log('\n########## 1. FIRMOGRAPHICS（顧客分布 × 実成約リフト） ##########');
console.log('\n=== 業種マクロ（顧客構成比） ===');
dist('業種マクロ').forEach(([k, n]) => console.log(`  ${String(n).padStart(4)} ${(100 * n / 289).toFixed(1).padStart(5)}%  ${k}`));

console.log('\n=== 従業員数バンド（顧客構成比 × 成約リフト） ===');
dist('従業員数バンド').forEach(([k, n]) => { const l = liftOf('emp', k); console.log(`  ${String(n).padStart(4)}  ${k.padEnd(14)}  リフト:${l ? l.toFixed(2) + 'x' : '—'}`); });

console.log('\n=== 採用数バンド（顧客構成比 × 成約リフト） ===');
dist('採用数バンド').forEach(([k, n]) => { const l = liftOf('hire', k); console.log(`  ${String(n).padStart(4)}  ${k.padEnd(10)}  リフト:${l ? l.toFixed(2) + 'x' : '—'}`); });

// ---- 2. 地域 ----
console.log('\n########## 2. 地域 ##########');
show('地域ブロック', '地域ブロック');
show('都道府県 TOP15', '都道府県', { top: 15 });

// ---- 3. 契約・プラン経済 ----
console.log('\n########## 3. 契約・プラン ##########');
show('基本プラン', '基本プラン');
show('獲得コホート年', '獲得コホート年');
show('獲得チャネル', '獲得チャネル');
// テナー統計
const ten = cust.map((r) => Number(r['テナー月数'])).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
console.log('\nテナー月数: 中央値', ten[Math.floor(ten.length / 2)], '平均', (ten.reduce((a, b) => a + b, 0) / ten.length).toFixed(1));
console.log('無料トライアル経由:', cust.filter((r) => r['無料トライアル経由'] === 'あり').length, '/', N);
console.log('プラン変更あり:', cust.filter((r) => r['プラン変更'] === 'あり').length, '| アップグレード:', cust.filter((r) => r['アップグレード'] === 'あり').length);

// ---- 4. 上場・メール属性 ----
console.log('\n########## 4. 上場・メール属性 ##########');
console.log('上場企業:', cust.filter((r) => r['上場'] === '上場').length, '/', N, `(${(100 * cust.filter((r) => r['上場'] === '上場').length / N).toFixed(0)}%)`);
show('ドメイン種別', 'ドメイン種別');
show('メール担当種別', 'メール担当種別');

// ---- 5. クロス集計 ----
console.log('\n########## 5. クロス集計 ##########');
function crosstab(rowKey, colKey, colOrder) {
  const rowsSet = [...new Set(cust.map((r) => r[rowKey]).filter(Boolean))];
  const cols = colOrder || [...new Set(cust.map((r) => r[colKey]).filter(Boolean))];
  const tab = {};
  for (const rk of rowsSet) tab[rk] = {};
  for (const r of cust) { if (!r[rowKey] || !r[colKey]) continue; tab[r[rowKey]][r[colKey]] = (tab[r[rowKey]][r[colKey]] || 0) + 1; }
  return { rowsSet, cols, tab };
}
// プラン × 従業員バンド
console.log('\n--- 基本プラン × 従業員数バンド ---');
{
  const { tab } = crosstab('基本プラン', '従業員数バンド');
  const plans = ['ミニマムプラン', 'スタンダード', 'ミドルプラン', 'データ利用プラン'];
  for (const p of plans) { if (!tab[p]) continue; const row = Object.entries(tab[p]).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join('  '); console.log(`  ${p.padEnd(12)} ${row}`); }
}
// プラン × 業種マクロ
console.log('\n--- 基本プラン × 業種マクロ（各プランの業種構成 上位） ---');
{
  const { tab } = crosstab('基本プラン', '業種マクロ');
  for (const p of ['スタンダード', 'ミドルプラン', 'ミニマムプラン']) { if (!tab[p]) continue; const row = Object.entries(tab[p]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}:${v}`).join('  '); console.log(`  ${p.padEnd(12)} ${row}`); }
}
// 業種マクロ × 従業員バンド（ヒートマップ的）
console.log('\n--- 業種マクロ × 従業員数バンド（顧客数） ---');
{
  const { tab, rowsSet } = crosstab('業種マクロ', '従業員数バンド');
  const bands = ['06:50-100', '07:100-300', '08:300-500', '09:500-1000', '10:1000-2000', '11:2000-5000'];
  console.log('  業種＼規模'.padEnd(24) + bands.map((b) => b.split(':')[1].padStart(9)).join(''));
  for (const rk of rowsSet.sort()) { const row = bands.map((b) => String(tab[rk][b] || '·').padStart(9)).join(''); console.log('  ' + rk.padEnd(22) + row); }
}
// 獲得チャネル × 業種マクロ
console.log('\n--- 獲得チャネル × 従業員数バンド（チャネル別の規模傾向） ---');
{
  const { tab } = crosstab('獲得チャネル', '従業員数バンド');
  for (const ch of Object.keys(tab)) { const row = Object.entries(tab[ch]).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k.split(':')[1]}:${v}`).join('  '); console.log(`  ${ch.padEnd(16)} ${row}`); }
}

// ---- 保存 ----
const summary = {
  n: N,
  業種マクロ: dist('業種マクロ'),
  従業員数バンド: dist('従業員数バンド').map(([k, n]) => ({ bucket: k, n, lift: liftOf('emp', k) })),
  採用数バンド: dist('採用数バンド').map(([k, n]) => ({ bucket: k, n, lift: liftOf('hire', k) })),
  地域ブロック: dist('地域ブロック'), 都道府県: dist('都道府県'),
  基本プラン: dist('基本プラン'), 獲得チャネル: dist('獲得チャネル'), 獲得コホート年: dist('獲得コホート年'),
  ドメイン種別: dist('ドメイン種別'), メール担当種別: dist('メール担当種別'),
  上場率: cust.filter((r) => r['上場'] === '上場').length / N,
  テナー中央値: ten[Math.floor(ten.length / 2)],
};
fs.writeFileSync(path.join(DATA, 'mochica-variable-analysis.json'), JSON.stringify(summary, null, 1));
console.log('\n保存: data/mochica-variable-analysis.json');
