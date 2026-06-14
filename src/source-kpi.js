'use strict';
// ソース別KPI評価ループ（設計#9「これを必ず回す」／背骨の原則②）。
//   件数で満足せず、ソース別に下流（接続→アポ→商談→受注）と1社あたりコストまで追い、
//   利回りの低いソースを止め、高いソースに資源を寄せる（2週間サイクルで判定）。
//
// 使い方:
//   node src/source-kpi.js --leads leads.master.scored.csv --outcomes outcomes.csv
//   node src/source-kpi.js --leads leads.scored.csv --attr origin   # 起点ソースのみで帰属（既定）
//   node src/source-kpi.js --leads leads.scored.csv --attr touch    # 接触した全ソースに帰属
//   node src/source-kpi.js --leads leads.scored.csv                 # 成果CSV無し=カバレッジ(件数/適合率)のみ
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { readCsv, mergeKey, truthy, csvEscape } = require('./csv');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}

// 成果セルの数値化：数値ならその値、truthy語なら1、空/否なら0
function oNum(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return 0;
  const n = parseFloat(s.replace(/[, ]/g, ''));
  if (Number.isFinite(n) && /^[\d.,\s]+$/.test(s)) return n;
  return truthy(s) ? 1 : 0;
}

// 成果CSV → Map(名寄せキー → {connect,appo,deal,won,cost})
function buildOutcomeIndex(outcomes, c = cfg) {
  const col = c.KPI_OUTCOME_COLS;
  const idx = new Map();
  for (const r of outcomes) {
    const k = mergeKey(r);
    if (!k) continue;
    idx.set(k, {
      connect: oNum(r[col.connect]), appo: oNum(r[col.appo]),
      deal: oNum(r[col.deal]), won: oNum(r[col.won]), cost: oNum(r[col.cost]),
    });
  }
  return idx;
}

// 1レコードの帰属ソース配列を返す（attr=origin: 起点ソースのみ / touch: 取得元媒体の全ソース）
function sourcesOf(rec, attr) {
  const combined = String(rec['取得元媒体'] || '').split('+').map((s) => s.trim()).filter(Boolean);
  const origin = String(rec['起点ソース'] || '').trim() || combined[0] || '(不明)';
  if (attr === 'touch') return combined.length ? combined : [origin];
  return [origin];
}

/**
 * ソース別KPIを集計。
 * @param {object[]} leads 採点済みリード（取得元媒体/起点ソース/品質スコア 列）
 * @param {Map|null} outcomeIdx 成果インデックス（無ければカバレッジのみ）
 * @param {object} opt { attr, fitMin, c }
 */
function computeSourceKpi(leads, outcomeIdx, opt = {}) {
  const c = opt.c || cfg;
  const attr = opt.attr || 'origin';
  const fitMin = opt.fitMin != null ? opt.fitMin : (c.KPI_FIT_SCORE_MIN || 60);
  const agg = new Map();
  const ensure = (s) => { if (!agg.has(s)) agg.set(s, { source: s, count: 0, fit: 0, connect: 0, appo: 0, deal: 0, won: 0, cost: 0, hasOutcome: 0 }); return agg.get(s); };

  for (const rec of leads) {
    const score = parseFloat(rec['品質スコア']);
    const isFit = Number.isFinite(score) ? score >= fitMin : false;
    const o = outcomeIdx ? outcomeIdx.get(mergeKey(rec)) : null;
    for (const s of sourcesOf(rec, attr)) {
      const a = ensure(s);
      a.count++;
      if (isFit) a.fit++;
      if (o) {
        a.hasOutcome++;
        a.connect += o.connect; a.appo += o.appo; a.deal += o.deal; a.won += o.won; a.cost += o.cost;
      }
    }
  }

  const rows = [];
  for (const a of agg.values()) {
    const pct = (num, den) => (den > 0 ? num / den : null);
    rows.push({
      source: a.source, count: a.count,
      fitRate: pct(a.fit, a.count),
      connectRate: pct(a.connect, a.count),
      appoPerConnect: pct(a.appo, a.connect),   // 接続→アポ率
      appoRate: pct(a.appo, a.count),
      dealRate: pct(a.deal, a.appo),             // 商談化率（アポ→商談）
      wonRate: pct(a.won, a.count),              // 受注率（件数比）
      costPer: pct(a.cost, a.count),
      cpa: pct(a.cost, a.appo),                  // アポ単価
      cpw: pct(a.cost, a.won),                   // 受注単価
      _raw: a,
    });
  }
  return rankAndRecommend(rows);
}

// 利回り（受注率優先・無ければアポ率）でランク付けし、寄せる/維持/止める を割り当てる
function rankAndRecommend(rows) {
  const hasWon = rows.some((r) => r._raw.won > 0);
  const key = hasWon ? 'wonRate' : 'appoRate';
  const vals = rows.map((r) => r[key]).filter((v) => v != null).sort((a, b) => a - b);
  const median = vals.length ? vals[Math.floor((vals.length - 1) / 2)] : null;

  for (const r of rows) {
    r.yieldKey = key;
    r.yieldVal = r[key];
    if (r.count < 5) { r.recommendation = '判定保留(母数<5)'; continue; }
    if (median == null || r.yieldVal == null) { r.recommendation = '成果データ待ち'; continue; }
    if (r.yieldVal >= median * 1.2) r.recommendation = '寄せる';
    else if (r.yieldVal <= median * 0.6) r.recommendation = '止める検討';
    else r.recommendation = '維持';
  }
  // 利回り降順 → 件数降順
  rows.sort((a, b) => (b.yieldVal || -1) - (a.yieldVal || -1) || b.count - a.count);
  return { rows, yieldKey: key, median };
}

function pctStr(v) { return v == null ? '  -  ' : (Math.round(v * 1000) / 10).toFixed(1).padStart(5) + '%'; }
function yenStr(v) { return v == null ? '   -' : Math.round(v).toLocaleString('en-US'); }

function main() {
  const leadsPath = getArg('leads', 'leads.master.csv');
  const outcomesPath = getArg('outcomes', null);
  const attr = (getArg('attr', 'origin') === 'touch') ? 'touch' : 'origin';
  const outPath = getArg('out', null);

  if (!fs.existsSync(leadsPath)) {
    console.error(`リードCSVが見つかりません: ${path.resolve(leadsPath)}\n先に node src/build-list.js でマスタを作成してください。`);
    process.exit(1);
  }
  const { records: leads } = readCsv(fs.readFileSync(leadsPath, 'utf8'));
  if (!leads.length) { console.error('リードが0件です。'); process.exit(1); }

  let outcomeIdx = null, outcomeN = 0;
  if (outcomesPath && fs.existsSync(String(outcomesPath))) {
    const { records: outs } = readCsv(fs.readFileSync(String(outcomesPath), 'utf8'));
    outcomeIdx = buildOutcomeIndex(outs, cfg);
    outcomeN = outcomeIdx.size;
  }

  const { rows, yieldKey, median } = computeSourceKpi(leads, outcomeIdx, { attr, c: cfg });

  const L = '──────────────────────────────────────────────────────────────';
  console.log('\n' + L);
  console.log('  ソース別KPI — 件数でなく「下流の接続→アポ→受注」で利回り評価');
  console.log(L);
  console.log(`  リード: ${path.resolve(leadsPath)}（${leads.length}社）`);
  console.log(`  帰属: ${attr === 'origin' ? '起点ソース' : '接触した全ソース'}  /  適合閾値: 品質スコア≥${cfg.KPI_FIT_SCORE_MIN}  /  評価サイクル: ${cfg.KPI_CYCLE_DAYS}日`);
  if (outcomeIdx) console.log(`  成果CSV: ${path.resolve(String(outcomesPath))}（${outcomeN}社突合）`);
  else console.log('  ⚠ 成果CSV未指定 → カバレッジ(件数/適合率/1社コスト)のみ。--outcomes で下流KPIが点火。');
  console.log(L);
  console.log('  ソース                件数  適合率  接続率 接→アポ 商談化  受注率  利回り 推奨');
  for (const r of rows) {
    const name = (r.source + '                    ').slice(0, 20);
    console.log(`  ${name}${String(r.count).padStart(4)} ${pctStr(r.fitRate)} ${pctStr(r.connectRate)} ${pctStr(r.appoPerConnect)} ${pctStr(r.dealRate)} ${pctStr(r.wonRate)} ${pctStr(r.yieldVal)} ${r.recommendation}`);
  }
  console.log(L);
  console.log(`  利回り指標 = ${yieldKey === 'wonRate' ? '受注率' : 'アポ率'}（中央値 ${pctStr(median)}）。中央値×1.2以上=寄せる／×0.6以下=止める検討。`);
  console.log(L + '\n');

  if (outPath) {
    const cols = ['ソース', '件数', '適合率', '接続率', '接続→アポ率', '商談化率', '受注率', '1社コスト', 'アポ単価', '受注単価', '利回り指標', '利回り値', '推奨'];
    const pf = (v) => (v == null ? '' : Math.round(v * 1000) / 10);
    const lines = [cols.map(csvEscape).join(',')];
    for (const r of rows) {
      lines.push([r.source, r.count, pf(r.fitRate), pf(r.connectRate), pf(r.appoPerConnect), pf(r.dealRate), pf(r.wonRate),
        r.costPer == null ? '' : Math.round(r.costPer), r.cpa == null ? '' : Math.round(r.cpa), r.cpw == null ? '' : Math.round(r.cpw),
        yieldKey === 'wonRate' ? '受注率' : 'アポ率', pf(r.yieldVal), r.recommendation].map(csvEscape).join(','));
    }
    fs.writeFileSync(String(outPath), lines.join('\n'), 'utf8');
    console.log(`KPI CSV: ${path.resolve(String(outPath))}\n`);
  }
}

module.exports = { computeSourceKpi, buildOutcomeIndex, sourcesOf, oNum, rankAndRecommend };

if (require.main === module) main();
