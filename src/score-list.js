'use strict';
// 営業リスト品質スコアリングCLI。担当者マスタCSV（既定 leads.csv）を読み、
// 4ディメンション加重スコア（src/quality.js）を各行に付与して書き出す。
//
// 使い方:
//   node src/score-list.js                         # leads.csv を採点 → leads.scored.csv
//   node src/score-list.js --input leads.csv --out scored.csv
//   node src/score-list.js --top 30               # 上位だけ表示
//   node src/score-list.js --min 70               # 総合スコア下限でフィルタ出力（今週架電のみ等）
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { getIcp } = require('./icp');
const { scoreRecord, getWeights } = require('./quality');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

// ---- CSVパース（ダブルクォート対応・改行/カンマ内包可）----
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(text).replace(/^﻿/, ''); // BOM除去
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r') { /* skip */ }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length && r.some((c) => String(c).trim() !== ''));
}

function rowsToRecords(rows) {
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const rec = {};
    headers.forEach((h, j) => { rec[h] = rows[i][j] != null ? rows[i][j] : ''; });
    records.push(rec);
  }
  return { headers, records };
}

function csvEscape(v) {
  const sv = String(v == null ? '' : v);
  return /[",\n]/.test(sv) ? '"' + sv.replace(/"/g, '""') + '"' : sv;
}

const SCORE_COLS = ['品質スコア', '優先度', '属性ランク', 'intent★', 'ICP適合', '採用インテント', 'データ品質', 'タイミング', 'インテント根拠', 'スコア根拠'];

function bar(n, width = 20) {
  const f = Math.round((n / 100) * width);
  return '█'.repeat(f) + '░'.repeat(width - f);
}

async function main() {
  const inputCsv = getArg('input', 'leads.csv');
  const outPath = getArg('out', null) || (String(inputCsv).replace(/\.csv$/i, '') + '.scored.csv');
  const top = parseInt(getArg('top', '15'), 10) || 15;
  const min = getArg('min', null) != null ? parseFloat(getArg('min')) : null;

  if (!fs.existsSync(inputCsv)) {
    console.error(`入力CSVが見つかりません: ${path.resolve(inputCsv)}\n先に node src/app.js でリストを作成してください。`);
    process.exit(1);
  }

  const icp = await getIcp(cfg);
  const w = getWeights(cfg);
  const { headers, records } = rowsToRecords(parseCsv(fs.readFileSync(inputCsv, 'utf8')));
  if (!records.length) { console.error('データ行が0件です。'); process.exit(1); }

  const now = new Date();
  const scored = records.map((rec) => {
    const s = scoreRecord(rec, { icp, now, c: cfg });
    return { rec, s };
  });
  // 総合スコア降順
  scored.sort((a, b) => b.s.total - a.s.total);

  // ---- 出力CSV（元列 + スコア列）----
  const outHeaders = headers.concat(SCORE_COLS.filter((c) => !headers.includes(c)));
  const lines = [outHeaders.map(csvEscape).join(',')];
  let proxyCount = 0;
  for (const { rec, s } of scored) {
    if (s.proxyIntent) proxyCount++;
    if (min != null && s.total < min) continue;
    const merged = Object.assign({}, rec, {
      '品質スコア': s.total, '優先度': s.priority,
      '属性ランク': s.grade, 'intent★': s.stars,
      'ICP適合': s.dims.icp, '採用インテント': s.dims.intent,
      'データ品質': s.dims.data, 'タイミング': s.dims.timing,
      'インテント根拠': s.proxyIntent ? '代理推定(出稿データ無)' : '出稿データ',
      'スコア根拠': s.reasons.join(' / '),
    });
    lines.push(outHeaders.map((h) => csvEscape(merged[h])).join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  // ---- コンソール集計 ----
  const total = scored.length;
  const prio = scored.reduce((a, x) => { a[x.s.priority] = (a[x.s.priority] || 0) + 1; return a; }, {});
  const avg = (key) => Math.round(scored.reduce((a, x) => a + (key === 'total' ? x.s.total : x.s.dims[key]), 0) / total);

  const L = '──────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  営業リスト品質スコアリング — 4ディメンション加重');
  console.log(L);
  console.log(`  入力: ${path.resolve(inputCsv)}（${total}社）`);
  console.log(`  ウェイト: ICP ${Math.round(w.icp * 100)}% / インテント ${Math.round(w.intent * 100)}% / データ ${Math.round(w.data * 100)}% / タイミング ${Math.round(w.timing * 100)}%`);
  console.log(L);
  console.log(`  ◆ 平均スコア`);
  console.log(`    総合          : ${avg('total')}  ${bar(avg('total'))}`);
  console.log(`    ① ICP適合     : ${avg('icp')}  ${bar(avg('icp'))}`);
  console.log(`    ② 採用インテント: ${avg('intent')}  ${bar(avg('intent'))}`);
  console.log(`    ③ データ品質   : ${avg('data')}  ${bar(avg('data'))}`);
  console.log(`    ④ タイミング   : ${avg('timing')}  ${bar(avg('timing'))}`);
  console.log(L);
  console.log(`  ◆ 架電優先度の振り分け`);
  console.log(`    今週架電(70+)      : ${prio['今週架電'] || 0}`);
  console.log(`    ナーチャリング(45-69): ${prio['ナーチャリング'] || 0}`);
  console.log(`    後回し(<45)        : ${prio['後回し'] || 0}`);
  console.log(L);
  if (proxyCount) {
    console.log(`  ⚠ 採用インテントは ${proxyCount}/${total}社が「代理推定」（求人出稿データ未連携）。`);
    console.log(`     HRogリスト等の出稿データ（新卒出稿/出稿媒体数/予想出稿金額/出稿継続性 列）を`);
    console.log(`     入力CSVに足すと、最重要ディメンションが実データで採点されます。`);
    console.log(L);
  }
  console.log(`  ◆ 上位${Math.min(top, scored.length)}社（総合｜ICP/INT/DAT/TIM｜優先度）`);
  scored.slice(0, top).forEach((x, i) => {
    const d = x.s.dims;
    console.log(`   ${String(i + 1).padStart(2)}. ${String(x.s.total).padStart(3)}｜${String(d.icp).padStart(3)}/${String(d.intent).padStart(3)}/${String(d.data).padStart(3)}/${String(d.timing).padStart(3)}｜${x.s.priority}  ${x.rec['企業名'] || ''}`);
  });
  console.log(L);
  console.log(`\n採点済みCSV: ${path.resolve(outPath)}${min != null ? `（総合${min}以上のみ出力）` : ''}\n`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
