'use strict';
// 核心仮説: 成約を左右する最大要因は「業種」でなく「リード獲得経路(コールド一括 vs 温かい/手入力)」か。
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../src/csv');
const { industryMacro, empBandLabel } = require('./lib-enrich');
const DATA = path.join(__dirname, '..', 'data');
const rows = parseCsv(fs.readFileSync(path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv'), 'utf8'));
const hIdx = rows.findIndex((r) => r.some((c) => String(c).includes('リードID18')));
const H = rows[hIdx].map((c) => String(c).trim());
const ci = (n) => { let i = H.indexOf(n); if (i >= 0) return i; const w = n.replace(/[（）()]/g, ''); return H.findIndex((h) => h.replace(/[（）()]/g, '') === w); };
const cStat = ci('リード 状況'), cInd = ci('業種'), cEmp = ci('従業員数レンジ(ランスケ）'), cS10 = ci('セミナーアンケート項目10'), cS7 = ci('セミナーアンケート項目7');
const recs = rows.slice(hIdx + 1).map((r) => ({
  conv: /コンバート/.test(r[cStat] || ''), ind: (r[cInd] || '').trim(), emp: (r[cEmp] || '').trim(),
  list: ((r[cS10] || '') + ' ' + (r[cS7] || '')).trim(),
}));
const rate = (arr) => arr.length ? (arr.filter((r) => r.conv).length / arr.length) : null;
const fmt = (arr) => arr.length ? `${(100 * rate(arr)).toFixed(1)}% (${arr.filter((r) => r.conv).length}/${arr.length})` : 'n/a';

// リード獲得経路の分類
function sourceClass(list) {
  const s = String(list || '').trim();
  if (!s) return '未タグ(温/手入力/古参)';
  if (/マイナビ|リクナビ/.test(s) && /20\d\d/.test(s)) return 'コールド媒体一括(年度リスト)';
  if (/お断り|リサイクル/.test(s)) return 'お断り再利用';
  if (/架電|アルバイト/.test(s)) return 'アウトバウンド架電';
  return 'その他タグ';
}
recs.forEach((r) => { r.src = sourceClass(r.list); });

console.log('全体成約率:', (100 * rate(recs)).toFixed(1) + '%', `(n=${recs.length})`);

console.log('\n########## テスト1: 獲得経路だけで成約率はどれだけ動くか ##########');
const bySrc = {};
for (const r of recs) { (bySrc[r.src] = bySrc[r.src] || []).push(r); }
Object.entries(bySrc).sort((a, b) => rate(b[1]) - rate(a[1])).forEach(([k, arr]) => {
  console.log('  ' + k.padEnd(26) + fmt(arr).padStart(18) + '  リフト' + (rate(arr) / rate(recs)).toFixed(2) + 'x');
});

console.log('\n########## テスト2: 経路を固定すると「業種」は生き残るか ##########');
// コールド媒体一括 内での業種マクロ別成約率
const cold = recs.filter((r) => r.src === 'コールド媒体一括(年度リスト)' && r.ind);
const warm = recs.filter((r) => r.src === '未タグ(温/手入力/古参)' && r.ind);
console.log('\n— コールド媒体一括 内での業種マクロ別（源泉を揃えた比較, n=' + cold.length + '）—');
const cm = {};
for (const r of cold) { const m = industryMacro(r.ind); if (!m) continue; (cm[m] = cm[m] || []).push(r); }
Object.entries(cm).filter(([, a]) => a.length >= 50).sort((a, b) => rate(b[1]) - rate(a[1])).forEach(([m, a]) => console.log('  ' + m.padEnd(20) + fmt(a).padStart(16) + '  リフト' + (rate(a) / rate(cold)).toFixed(2) + 'x'));
console.log('  → コールド内 全体:', (100 * rate(cold)).toFixed(1) + '%');
console.log('\n— 未タグ(温) 内での業種マクロ別（n=' + warm.length + '）—');
const wm = {};
for (const r of warm) { const m = industryMacro(r.ind); if (!m) continue; (wm[m] = wm[m] || []).push(r); }
Object.entries(wm).filter(([, a]) => a.length >= 50).sort((a, b) => rate(b[1]) - rate(a[1])).forEach(([m, a]) => console.log('  ' + m.padEnd(20) + fmt(a).padStart(16) + '  リフト' + (rate(a) / rate(warm)).toFixed(2) + 'x'));
console.log('  → 未タグ 全体:', (100 * rate(warm)).toFixed(1) + '%');

console.log('\n########## テスト3: 経路を固定すると「規模」は生き残るか（コールド媒体一括内） ##########');
const bandOrder = ['05:30-50', '06:50-100', '07:100-300', '08:300-500', '09:500-1000', '10:1000-2000', '11:2000-5000'];
const cb = {};
for (const r of cold) { const b = empBandLabel(r.emp); if (!b) continue; (cb[b] = cb[b] || []).push(r); }
bandOrder.forEach((b) => { if (cb[b]) console.log('  ' + b.padEnd(14) + fmt(cb[b]).padStart(16) + '  リフト' + (rate(cb[b]) / rate(cold)).toFixed(2) + 'x'); });
