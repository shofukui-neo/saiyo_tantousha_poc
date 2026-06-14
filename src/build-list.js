'use strict';
// 統合オーケストレータ（設計「6. 統合オペレーション」の司令塔）。
//   多系統ソース（A=採用メディア/B=属性/C=intent/D=ネットワーク）を manifest で受け取り、
//   ① merge.js で法人番号名寄せ・重複排除・役割固定マージ・出所/intent★ 付与
//   ② quality.js で4ディメンション採点・属性ランク・優先度（intent★割り込み）
//   ③ 採点済みマスタCSVを優先度降順で出力＋カバレッジ・サマリ表示
//   （--kpi outcomes.csv を渡すと続けてソース別KPIも算出）
//
// 使い方:
//   node src/build-list.js --sources sources/manifest.json --out leads.master.csv
//   node src/build-list.js --sources sources/manifest.json --kpi sources/outcomes.csv
//   node src/build-list.js --dir sources --out leads.master.csv   # ディレクトリ内CSVを系統推定で取込
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { readCsv, toCsv } = require('./csv');
const { mergeSources } = require('./merge');
const { scoreRecord } = require('./quality');
const { getIcp } = require('./icp');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

// manifest（JSON）を読み、各ソースのレコードを読み込む。file はmanifestからの相対。
function loadFromManifest(manifestPath) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.sources || []);
  const base = path.dirname(path.resolve(manifestPath));
  const sources = [];
  for (const s of list) {
    const fp = path.isAbsolute(s.file) ? s.file : path.join(base, s.file);
    if (!fs.existsSync(fp)) { console.warn(`  ⚠ ソース欠落（スキップ）: ${fp}`); continue; }
    const { records } = readCsv(fs.readFileSync(fp, 'utf8'));
    sources.push({
      system: String(s.system || 'B').toUpperCase(),
      source: s.source || path.basename(fp),
      intent: s.intent != null ? Number(s.intent) : undefined,
      cost: s.cost_per_company != null ? Number(s.cost_per_company) : undefined,
      records,
    });
  }
  return sources;
}

// ディレクトリ内CSVを取込。ファイル名先頭 A-/B-/C-/D- で系統を推定（無ければB）。
function loadFromDir(dir) {
  const sources = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.csv$/i.test(f)) continue;
    if (/outcome|成果|kpi/i.test(f)) continue; // 成果CSVはソースではない（--kpi で渡す）
    const m = f.match(/^([ABCD])[-_]/i);
    const { records } = readCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
    sources.push({ system: m ? m[1].toUpperCase() : 'B', source: f.replace(/\.csv$/i, ''), records });
  }
  return sources;
}

// 出力列の優先順（残りは後ろに自動追記）
const OUT_PRIORITY = [
  '企業名', '法人番号', '品質スコア', '優先度', '属性ランク', 'intent★', '新卒フラグ',
  '系統', '取得元媒体', '起点系統', '起点ソース', 'ソース数', 'トリガー',
  '採用担当者名', '役職', '部署', '代表者名', 'メール', 'メール確度', '担当者確度', '電話番号', '公式URL',
  '業種', '都道府県', '従業員数', '設立年', '補助金',
  'ICP適合', '採用インテント', 'データ品質', 'タイミング', 'インテント根拠', 'スコア根拠', '取得日',
];

const SCORE_COLS = ['品質スコア', '優先度', '属性ランク', 'intent★', 'ICP適合', '採用インテント', 'データ品質', 'タイミング', 'インテント根拠', 'スコア根拠'];

async function main() {
  const manifest = getArg('sources', null);
  const dir = getArg('dir', null);
  const outPath = getArg('out', 'leads.master.csv');
  const kpiOutcomes = getArg('kpi', null);

  if (!manifest && !dir) {
    console.error('使い方: node src/build-list.js --sources sources/manifest.json [--out leads.master.csv] [--kpi outcomes.csv]\n'
      + '   または: node src/build-list.js --dir sources');
    process.exit(1);
  }

  let sources;
  try {
    sources = manifest ? loadFromManifest(String(manifest)) : loadFromDir(String(dir));
  } catch (e) { console.error('ソース読込エラー:', e.message); process.exit(1); }
  if (!sources.length) { console.error('有効なソースがありません。'); process.exit(1); }

  // ① マージ・名寄せ
  const { master, stats } = mergeSources(sources, cfg);

  // ② 採点
  const icp = await getIcp(cfg);
  const now = new Date();
  const scored = master.map((rec) => {
    const s = scoreRecord(rec, { icp, now, c: cfg });
    return Object.assign({}, rec, {
      '品質スコア': s.total, '優先度': s.priority, '属性ランク': s.grade, 'intent★': rec['intent★'] != null ? rec['intent★'] : s.stars,
      'ICP適合': s.dims.icp, '採用インテント': s.dims.intent, 'データ品質': s.dims.data, 'タイミング': s.dims.timing,
      'インテント根拠': s.proxyIntent ? '代理推定(出稿/フラグ無)' : '実シグナル', 'スコア根拠': s.reasons.join(' / '),
      _total: s.total, _prio: s.priority,
    });
  });
  scored.sort((a, b) => b._total - a._total);

  // ③ 出力
  const present = new Set();
  scored.forEach((r) => Object.keys(r).forEach((k) => { if (!k.startsWith('_')) present.add(k); }));
  SCORE_COLS.forEach((c) => present.add(c));
  const headers = OUT_PRIORITY.filter((h) => present.has(h))
    .concat(Array.from(present).filter((h) => OUT_PRIORITY.indexOf(h) < 0 && h !== '名寄せキー'));
  const clean = scored.map((r) => { const o = Object.assign({}, r); delete o._total; delete o._prio; delete o['名寄せキー']; return o; });
  fs.writeFileSync(outPath, toCsv(headers, clean), 'utf8');

  // ---- サマリ ----
  const prio = scored.reduce((a, x) => { a[x._prio] = (a[x._prio] || 0) + 1; return a; }, {});
  const L = '──────────────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  究極の営業リスト — 多系統統合ビルド');
  console.log(L);
  console.log(`  入力ソース: ${sources.length}本`);
  for (const [sys, v] of Object.entries(stats.bySystem)) {
    console.log(`    系統${sys} ${(cfg.SOURCE_SYSTEMS[sys] || '')}: ${v.sources}ソース / 生${v.raw}件`);
  }
  console.log(L);
  console.log(`  名寄せ: 生${stats.rawCount}件 → ユニーク${stats.unique}社（重複排除${stats.dedupRemoved}件${stats.noKey ? ` / キー無し${stats.noKey}件除外` : ''}）`);
  console.log(`    新卒フラグ確定: ${stats.flagged}社（${Math.round(stats.flagged / stats.unique * 100)}%）`);
  console.log(`    複数ソース突合: ${stats.multiSource}社（属性が肉付けされた精度の高い行）`);
  console.log(`    intent★分布: ` + [5, 4, 3, 2, 1, 0].map((s) => `★${s}:${stats.starHist[s] || 0}`).join('  '));
  console.log(L);
  console.log(`  架電優先度:  今週架電 ${prio['今週架電'] || 0}  /  ナーチャリング ${prio['ナーチャリング'] || 0}  /  後回し ${prio['後回し'] || 0}`);
  console.log(L);
  console.log(`  ◆ 上位${Math.min(15, scored.length)}社（総合｜ランク★｜優先度）`);
  scored.slice(0, 15).forEach((x, i) => {
    console.log(`   ${String(i + 1).padStart(2)}. ${String(x._total).padStart(3)}｜${x['属性ランク']}★${x['intent★']}｜${x._prio}  ${x['企業名'] || ''}  [${x['取得元媒体'] || ''}]`);
  });
  console.log(L);
  console.log(`\nマスタCSV: ${path.resolve(outPath)}（${scored.length}社・優先度降順）\n`);

  // ④ 任意：ソース別KPI（成果CSVがあれば続けて算出）
  if (kpiOutcomes) {
    const { computeSourceKpi, buildOutcomeIndex } = require('./source-kpi');
    let outcomeIdx = null;
    if (fs.existsSync(String(kpiOutcomes))) {
      const { records } = readCsv(fs.readFileSync(String(kpiOutcomes), 'utf8'));
      outcomeIdx = buildOutcomeIndex(records, cfg);
    } else { console.warn(`  ⚠ 成果CSV欠落: ${kpiOutcomes}（カバレッジのみ）`); }
    const { rows, yieldKey, median } = computeSourceKpi(clean, outcomeIdx, { attr: 'origin', c: cfg });
    const pctStr = (v) => (v == null ? '  -  ' : (Math.round(v * 1000) / 10).toFixed(1).padStart(5) + '%');
    console.log(L);
    console.log('  ◆ ソース別KPI（起点ソース帰属・利回り=' + (yieldKey === 'wonRate' ? '受注率' : 'アポ率') + '）');
    console.log('  ソース                件数  適合率  受注/アポ率 推奨');
    for (const r of rows) {
      console.log(`  ${(r.source + '                    ').slice(0, 20)}${String(r.count).padStart(4)} ${pctStr(r.fitRate)}  ${pctStr(r.yieldVal)}    ${r.recommendation}`);
    }
    console.log(`  中央値 ${pctStr(median)} ／ ×1.2以上=寄せる・×0.6以下=止める検討（${cfg.KPI_CYCLE_DAYS}日サイクル）`);
    console.log(L + '\n');
  }
}

module.exports = { loadFromManifest, loadFromDir, OUT_PRIORITY };

if (require.main === module) main().catch((e) => { console.error('FATAL', e); process.exit(1); });
