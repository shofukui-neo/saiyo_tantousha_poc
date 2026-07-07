'use strict';
/**
 * 実証ICP: SF全リード(コンバート/非コンバート)から属性バケット別の実コンバージョン率を算出。
 * 「どんな属性の企業が実際に顧客化したか」を仮説でなくデータで定義する。
 *   convRate(bucket) = コンバート数 / (そのバケットを持つ全リード数)
 * これを 業種 / 従業員数バンド / 採用人数バンド の3軸で出す。
 */
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../src/csv');
const { classifyChannel } = require('../src/channel-temp');
const DATA = path.join(__dirname, '..', 'data');
const readText = (p) => fs.readFileSync(p, 'utf8');

const SF = path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv');
const rows = parseCsv(readText(SF));
const hIdx = rows.findIndex((r) => r.some((c) => String(c).includes('リードID18')));
const H = rows[hIdx].map((c) => String(c).trim());
const idx = (name) => { let i = H.indexOf(name); if (i >= 0) return i; const w = name.replace(/[（）()]/g, ''); return H.findIndex((h) => h.replace(/[（）()]/g, '') === w); };
const cName = idx('会社名 / 取引先'), cHire = idx('採用人数(選択リスト)'), cStat = idx('リード 状況'), cEmp = idx('従業員数レンジ(ランスケ）'), cInd = idx('業種');
// 経路の温度（第4軸）: リスト名＝セミナーアンケート項目10 + 7
const cS10 = idx('セミナーアンケート項目10'), cS7 = idx('セミナーアンケート項目7');
const recs = rows.slice(hIdx + 1).map((r) => ({
  name: (r[cName] || '').trim(), hire: (r[cHire] || '').trim(), status: (r[cStat] || '').trim(),
  emp: (r[cEmp] || '').trim(), ind: (r[cInd] || '').trim(),
  channel: classifyChannel(((cS10 >= 0 ? r[cS10] : '') || '') + ' ' + ((cS7 >= 0 ? r[cS7] : '') || '')),
})).filter((r) => r.name && !/^(テスト|.*テスト)/.test(r.name));
const isConv = (r) => /コンバート/.test(r.status);

// ---- 従業員数バンド正規化 ----
function empBand(v) {
  if (!v || /不明|^-$/.test(v)) return null;
  const s = v.replace(/,/g, '');
  // レンジ表記優先
  if (/1～5人|1~5人/.test(s)) return '01:<5';
  if (/5～10|5~10/.test(s)) return '02:5-10';
  if (/10～20|10~20/.test(s)) return '03:10-20';
  if (/20～30|20~30/.test(s)) return '04:20-30';
  if (/30～50|30~50/.test(s)) return '05:30-50';
  if (/50～100|50~100|50人未満/.test(s)) return '06:50-100';
  if (/100～300|100~300|100～200|100～500|100～1千/.test(s)) return '07:100-300';
  if (/300～500|300～1千/.test(s)) return '08:300-500';
  if (/500～1千|500～1000/.test(s)) return '09:500-1000';
  if (/1千～2千|1000～2千|1千人～1万|1千人～5000|1千～1万/.test(s)) return '10:1000-2000';
  if (/2千～5千/.test(s)) return '11:2000-5000';
  if (/5千～1万/.test(s)) return '12:5000-10000';
  if (/1万|1万人～|1万～/.test(s)) return '13:10000+';
  // 生数値
  const n = parseInt((s.match(/\d+/) || [])[0] || '', 10);
  if (Number.isFinite(n)) {
    if (n < 5) return '01:<5'; if (n < 10) return '02:5-10'; if (n < 20) return '03:10-20';
    if (n < 30) return '04:20-30'; if (n < 50) return '05:30-50'; if (n < 100) return '06:50-100';
    if (n < 300) return '07:100-300'; if (n < 500) return '08:300-500'; if (n < 1000) return '09:500-1000';
    if (n < 2000) return '10:1000-2000'; if (n < 5000) return '11:2000-5000'; if (n < 10000) return '12:5000-10000';
    return '13:10000+';
  }
  return null;
}
// ---- 採用人数バンド正規化 ----
function hireBand(v) {
  if (!v || /不明/.test(v)) return null;
  if (/1～2名|1~2/.test(v)) return '1:1-2';
  if (/3～5名|3~5/.test(v)) return '2:3-5';
  if (/6～10名|6~10/.test(v)) return '3:6-10';
  if (/11～15|11~15/.test(v)) return '4:11-15';
  if (/16～20|16~20/.test(v)) return '5:16-20';
  if (/21～25|26～30|21~25|26~30/.test(v)) return '6:21-30';
  if (/31～35|36～40|41～45|46～50|3[16]～|41～|46～/.test(v)) return '7:31-50';
  if (/51～100/.test(v)) return '8:51-100';
  if (/101～200|201～300|301名/.test(v)) return '9:101+';
  return null;
}

function convByBucket(bucketFn, keyName) {
  const tot = new Map(), conv = new Map();
  for (const r of recs) {
    const b = bucketFn(r[keyName]);
    if (b == null) continue;
    tot.set(b, (tot.get(b) || 0) + 1);
    if (isConv(r)) conv.set(b, (conv.get(b) || 0) + 1);
  }
  const out = [...tot.entries()].map(([b, t]) => {
    const c = conv.get(b) || 0;
    return { bucket: b, total: t, conv: c, rate: c / t };
  });
  return out;
}

function report(title, arr, sortByRate) {
  console.log('\n=== ' + title + ' ===');
  const rows = arr.slice().sort((a, b) => sortByRate ? b.rate - a.rate : a.bucket.localeCompare(b.bucket));
  console.log('  bucket'.padEnd(22) + 'conv/total'.padStart(14) + '  convRate  lift');
  const overall = recs.filter(isConv).length / recs.length;
  for (const r of rows) {
    const lift = (r.rate / overall);
    console.log('  ' + r.bucket.padEnd(20) + `${r.conv}/${r.total}`.padStart(14) + `  ${(100 * r.rate).toFixed(1)}%`.padStart(8) + `   ${lift.toFixed(2)}x`);
  }
}
const overall = recs.filter(isConv).length / recs.length;
console.log('全体コンバージョン率:', (100 * overall).toFixed(1) + '%', `(${recs.filter(isConv).length}/${recs.length})`);

report('従業員数バンド別 コンバージョン率', convByBucket(empBand, 'emp'), false);
report('採用人数バンド別 コンバージョン率', convByBucket(hireBand, 'hire'), false);
// 第4軸: 経路の温度（獲得チャネル）— 最大レバー
report('経路の温度別 コンバージョン率（rate順）', convByBucket((v) => v || null, 'channel'), true);

// 業種は生値 → コンバート率順（母数>=40のみ, ノイズ除去）
const indArr = convByBucket((v) => (v && v.trim()) || null, 'ind').filter((r) => r.total >= 40);
report('業種別 コンバージョン率（母数≥40, rate順）', indArr, true);

// 保存: バケット別convRateをJSONに（スコアラで使用）
const save = {
  overall,
  channel: convByBucket((v) => v || null, 'channel'), // 第4軸（最大レバー）を先頭付近に
  emp: convByBucket(empBand, 'emp'),
  hire: convByBucket(hireBand, 'hire'),
  industry: convByBucket((v) => (v && v.trim()) || null, 'ind').filter((r) => r.total >= 20),
};
fs.writeFileSync(path.join(DATA, 'empirical-icp-rates.json'), JSON.stringify(save, null, 2));
console.log('\nsaved data/empirical-icp-rates.json');
