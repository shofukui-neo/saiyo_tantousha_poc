'use strict';
// 仮説検証: ①業種の未開拓度(架電量 vs 成約率) ②複合ラベルの効果は規模交絡か(規模固定比較) ③リスト起源と業種粒度
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
  conv: /コンバート/.test(r[cStat] || ''), ind: (r[cInd] || '').trim(),
  emp: (r[cEmp] || '').trim(), list: ((r[cS10] || '') + ' ' + (r[cS7] || '')).trim(),
})).filter((r) => r.ind);
const overall = recs.filter((r) => r.conv).length / recs.length;

// ===== 仮説D: 未開拓度（架電量 vs 成約率） =====
console.log('########## 仮説D: 高効率業種は「飽和」でなく「未開拓」か ##########');
const macro = {};
for (const r of recs) { const m = industryMacro(r.ind); if (!m) continue; (macro[m] = macro[m] || { t: 0, c: 0 }); macro[m].t++; if (r.conv) macro[m].c++; }
const totalLeads = Object.values(macro).reduce((s, x) => s + x.t, 0);
const totalConv = Object.values(macro).reduce((s, x) => s + x.c, 0);
console.log('業種マクロ'.padEnd(20) + 'リード数  成約率  架電シェア  成約シェア  効率/量ギャップ');
Object.entries(macro).sort((a, b) => (b[1].c / b[1].t) - (a[1].c / a[1].t)).forEach(([m, x]) => {
  const rate = x.c / x.t, leadShare = x.t / totalLeads, convShare = x.c / totalConv;
  const gap = (rate / overall) / (leadShare / (1 / Object.keys(macro).length)); // 成約リフト ÷ 架電量の相対
  console.log(m.padEnd(20) + String(x.t).padStart(6) + '  ' + (100 * rate).toFixed(1).padStart(5) + '%  ' + (100 * leadShare).toFixed(1).padStart(6) + '%  ' + (100 * convShare).toFixed(1).padStart(6) + '%');
});
// 「もし高効率業種を製造並みに架電したら」試算
const mfg = macro['製造・メーカー'];
console.log('\n— 試算: 製造(', mfg.t, 'リード,', (100 * mfg.c / mfg.t).toFixed(1) + '%) と同数を各業種に架電したら得られる成約数 —');
['流通・小売', '金融・保険', '医療・介護・福祉', '商社・卸'].forEach((m) => {
  const x = macro[m]; const rate = x.c / x.t;
  console.log('  ' + m.padEnd(14) + ' 現状' + String(x.c).padStart(4) + '成約(' + x.t + 'リード) → 製造並み' + mfg.t + 'リードなら約' + Math.round(rate * mfg.t) + '成約 (現実成約率' + (100 * rate).toFixed(1) + '%)');
});

// ===== 仮説C: 複合ラベルの効果は「規模の交絡」か =====
console.log('\n########## 仮説C: 複合ラベル高成約は規模交絡でないか（100-500名に固定して比較） ##########');
function rateOfLabel(label, bandFilter) {
  const sub = recs.filter((r) => r.ind === label && (!bandFilter || bandFilter(empBandLabel(r.emp))));
  if (!sub.length) return null;
  return { t: sub.length, c: sub.filter((r) => r.conv).length, rate: sub.filter((r) => r.conv).length / sub.length };
}
const in100to500 = (b) => b === '07:100-300' || b === '08:300-500';
const pairs = [
  ['流通・小売・物販', 'スーパーマーケット'], ['金融・保険', '信用金庫'],
  ['メーカー （機械・電気・電子）', '機械'], ['介護・保育・医療法人等', '福祉サービス'],
  ['商社', '商社（鉄鋼・金属）'],
];
console.log('（100-500名に限定した成約率）  複合ラベル vs 細分ラベル');
for (const [comp, gran] of pairs) {
  const a = rateOfLabel(comp, in100to500), b = rateOfLabel(gran, in100to500);
  const af = a ? `${(100 * a.rate).toFixed(1)}% (${a.c}/${a.t})` : 'n/a';
  const bf = b ? `${(100 * b.rate).toFixed(1)}% (${b.c}/${b.t})` : 'n/a';
  console.log('  ' + comp.padEnd(22) + af.padStart(16) + '   vs   ' + gran.padEnd(14) + bf.padStart(16));
}

// ===== 仮説C-2: 複合ラベルは新しいリスト由来か（リスト名の年度） =====
console.log('\n########## 仮説C-2: 複合ラベルは新しい/温かいリスト由来か（リスト名の年） ##########');
function listYearProfile(label) {
  const sub = recs.filter((r) => r.ind === label);
  const yr = {};
  for (const r of sub) { const m = (r.list.match(/20(2[0-9])/) || [])[0] || (r.list ? '記載あり(年なし)' : '(リスト名なし)'); yr[m] = (yr[m] || 0) + 1; }
  return { n: sub.length, yr: Object.entries(yr).sort((a, b) => b[1] - a[1]).slice(0, 4) };
}
for (const lab of ['流通・小売・物販', 'スーパーマーケット', '金融・保険', '信用金庫', 'メーカー （機械・電気・電子）', '機械']) {
  const p = listYearProfile(lab);
  console.log('  ' + lab.padEnd(22) + 'n=' + String(p.n).padStart(5) + '  ' + p.yr.map(([k, v]) => `${k}:${v}`).join('  '));
}
