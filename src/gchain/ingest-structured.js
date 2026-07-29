'use strict';
/**
 * G-Chain OS v2.0 — 構造化シグナル分析ドライバ（設計書 §4-§6・MiiTel非依存）。
 *
 * 5本柱を実データで算出:
 *  ①接続最適化 ②成果リフトスコアリング ③失注インテリジェンス ④再活性化タイミング ⑤行動規律
 * 入力は ingest-wave0 と同一3ファイル。MiiTel不使用。
 * 出力: data/gchain/ v2/ 配下（report.md・lift-*.csv・scored-uncalled.csv・quality.json）
 * 実行: node src/gchain/ingest-structured.js
 */
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../csv');
const G = require('./index');
const { buildExistingCustomerSet, buildSfLeadSet, NG_TYPES_BLOCK } = require('./ingest-wave0');

const DATA = path.join(__dirname, '..', '..', 'data');
const OUT = path.join(DATA, 'gchain', 'v2');
const F_BALES = path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');

function readBales() {
  const rows = parseCsv(fs.readFileSync(F_BALES, 'utf8'));
  const head = rows[0];
  const recs = [];
  for (let r = 1; r < rows.length; r++) {
    const o = {};
    head.forEach((h, i) => { o[h] = rows[r][i]; });
    recs.push(o);
  }
  return recs;
}

// リフト対象の特徴キー（extractFeatures の出力キー）
const LIFT_KEYS = ['icp_band', 'recruit_size', 'source', 'industry', 'current_ats', 'consider_timing', 'call_band', 'call_weekday'];

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const today = '2026-07-16';
  const refMonth = { y: 2026, m: 7, today };

  const custSet = buildExistingCustomerSet();
  const sf = buildSfLeadSet();
  const recs = readBales();

  // 特徴・ラベル付与
  const enriched = recs.map((rec) => {
    const { features, leak } = G.features.extractFeatures(rec);
    const labels = G.outcome.extractLabels(rec);
    const called = (rec['コール結果1：結果'] || '').trim() !== '';
    return { rec, features, leak, labels, called };
  });
  const leakCount = enriched.filter((e) => e.leak.length).length;
  const called = enriched.filter((e) => e.called);
  const uncalled = enriched.filter((e) => !e.called);

  // ① 接続最適化: セグメント別 E2率（担当接続/架電）
  const connByBand = segmentRate(called, (e) => e.features.call_band, (e) => e.labels.connected);
  const connBySize = segmentRate(called, (e) => e.features.icp_band, (e) => e.labels.connected);

  // ② 成果リフト: appointment（架電あたりアポ）over 各特徴。base=全架電のアポ率
  const apptLabel = (e) => e.labels.appointment;
  const model = G.outcome.buildLiftModel(called, LIFT_KEYS, (e) => e.features, apptLabel, { minN: 50 });
  const liftTables = {};
  for (const key of LIFT_KEYS) {
    liftTables[key] = G.outcome.liftByFeature(called, (e) => e.features[key], apptLabel, { minN: 50, base: model.base });
  }

  // 未架電リードをスコアリング（company名はPII→data/gchainはgitignore）
  const scoredUncalled = uncalled.map((e) => {
    const s = G.outcome.scoreLead(e.features, model);
    return {
      company: (e.rec['会社情報：会社名'] || '').trim(),
      score: s.score, icp_band: e.features.icp_band, source: e.features.source,
      recruit_size: e.features.recruit_size, top_factor: s.contributions[0] ? s.contributions[0].key + '=' + s.contributions[0].value : '',
    };
  }).sort((a, b) => b.score - a.score);

  // ③ 失注インテリジェンス
  const lost = called.filter((e) => e.labels.lost).map((e) => e.rec);
  const lossSummary = G.lossIntel.summarizeLoss(lost, (r) => (r['カスタム情報：失注商談失注理由大'] || '').trim());

  // ④ 再活性化: リサイクル/ペンディング系ステージの優先度
  const recyclable = enriched.filter((e) => /リサイクル|ペンディング|失注|情報収集/.test((e.rec['リード関連情報：最終リードステージ'] || '')));
  const react = recyclable.map((e) => {
    const p = G.reactivation.reactivationPriority({
      consider_timing: e.rec['カスタム情報：検討開始時期'],
      renewal_month: e.rec['カスタム情報：現利用サービス更新予定月'],
      next_action_date: e.rec['カスタム情報：失注後次回アクション日'],
      loss_date: e.rec['カスタム情報：失注商談失注日'],
    }, refMonth);
    return { company: (e.rec['会社情報：会社名'] || '').trim(), priority: p.priority, reasons: p.reasons.join('; ') };
  }).filter((x) => x.priority > 0).sort((a, b) => b.priority - a.priority);

  // ⑤ 行動規律: 所有者別
  const disc = G.discipline.disciplineByOwner(recs, today, (r) => (r['リード関連情報：リード所有者'] || '').trim());

  // 出力
  writeCsv(path.join(OUT, 'scored-uncalled.csv'), scoredUncalled.slice(0, 2000));
  writeCsv(path.join(OUT, 'reactivation-queue.csv'), react.slice(0, 2000));
  for (const key of LIFT_KEYS) writeCsv(path.join(OUT, `lift-${key}.csv`), liftTables[key]);
  const quality = {
    total: recs.length, called: called.length, uncalled: uncalled.length,
    feature_leak_count: leakCount, base_appointment_rate: model.base,
    existing_customers: custSet.size, sf_leads: sf.count,
  };
  fs.writeFileSync(path.join(OUT, 'quality.json'), JSON.stringify(quality, null, 2));

  const report = buildReport({ recs, called, uncalled, model, liftTables, connByBand, connBySize, lossSummary, react, disc, scoredUncalled, quality });
  fs.writeFileSync(path.join(OUT, 'report.md'), report);
  console.log(report);
  console.log(`\n出力: ${path.relative(process.cwd(), OUT)}/ (report.md・lift-*.csv・scored-uncalled.csv ${scoredUncalled.length}件・reactivation-queue.csv ${react.length}件)`);
}

function segmentRate(items, keyFn, labelFn) {
  const g = new Map();
  for (const it of items) {
    const k = keyFn(it); if (k == null) continue;
    if (!g.has(k)) g.set(k, { n: 0, hits: 0 });
    const o = g.get(k); o.n++; if (labelFn(it)) o.hits++;
  }
  return [...g.entries()].map(([k, o]) => ({ value: k, n: o.n, rate: o.n ? o.hits / o.n : 0 }))
    .sort((a, b) => b.rate - a.rate);
}

function writeCsv(file, rows) {
  if (!rows.length) { fs.writeFileSync(file, ''); return; }
  const head = Object.keys(rows[0]);
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  fs.writeFileSync(file, [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n'));
}

function pct(x) { return x == null ? '—' : (100 * x).toFixed(1) + '%'; }
function liftTable(rows, label, n) {
  const L = [`| ${label} | n | アポ率 | 平滑率 | リフト |`, '|---|---|---|---|---|'];
  for (const r of rows.slice(0, n)) L.push(`| ${r.value} | ${r.n} | ${pct(r.rate)} | ${pct(r.smoothed_rate)} | ${r.lift}x |`);
  return L.join('\n');
}

function buildReport(d) {
  const L = [];
  L.push('# G-Chain OS v2.0 — 構造化シグナル分析レポート（MiiTel非依存）');
  L.push('');
  L.push('> 設計: docs/g-chain-os-v2.0-structured-only.md。会話質は扱わない。接続/成果/失注/再活性化/行動規律を構造化データで確定。');
  L.push('');
  L.push('## 0. データ品質');
  L.push(`- 総リード ${d.quality.total.toLocaleString()} / 架電済 ${d.quality.called.toLocaleString()} / 未架電 ${d.quality.uncalled.toLocaleString()}`);
  L.push(`- 特徴リーク検出: ${d.quality.feature_leak_count} 件（未来情報の混入。0が理想）`);
  L.push(`- ベースアポ率（架電あたり）: **${pct(d.model.base)}**`);
  L.push('');
  L.push('## 1. 接続最適化（担当接続率 E2/架電）');
  L.push('**時間帯別**');
  L.push('| 時間帯 | n | 接続率 |');
  L.push('|---|---|---|');
  for (const r of d.connByBand) L.push(`| ${r.value} | ${r.n} | ${pct(r.rate)} |`);
  L.push('');
  L.push('**ICP帯別**');
  L.push('| ICP帯 | n | 接続率 |');
  L.push('|---|---|---|');
  for (const r of d.connBySize) L.push(`| ${r.value} | ${r.n} | ${pct(r.rate)} |`);
  L.push('');
  L.push('## 2. 成果リフトスコアリング（架電あたりアポ率・minN=50・ラプラス平滑化）');
  L.push('「どのセグメントを厚くすればアポが増えるか」。リフト>1が優良、<1が不利。');
  L.push('');
  L.push('**リードソース別（利回り）**');
  L.push(liftTable(d.liftTables.source, 'ソース', 12));
  L.push('');
  L.push('**採用人数帯別**');
  L.push(liftTable(d.liftTables.recruit_size, '採用人数', 10));
  L.push('');
  L.push('**架電時間帯別**');
  L.push(liftTable(d.liftTables.call_band, '時間帯', 6));
  L.push('');
  L.push('**利用中ATS別**');
  L.push(liftTable(d.liftTables.current_ats, 'ATS', 10));
  L.push('');
  L.push('## 3. 未架電リードのスコアリング（成果予測 → リスト還元）');
  L.push(`- 未架電 ${d.uncalled.length.toLocaleString()} 件を学習モデルでスコア。上位ほどアポ期待値が高い。`);
  L.push(`- 上位20件の平均スコア: **${pct(avg(d.scoredUncalled.slice(0, 20).map((x) => x.score)))}** / 全体平均: ${pct(avg(d.scoredUncalled.map((x) => x.score)))}`);
  L.push('- → data/gchain/v2/scored-uncalled.csv（社名含むPIIのためローカル限定）。リスト作成システムへ還元可能。');
  L.push('');
  L.push('## 4. 失注インテリジェンス（構造化帰属）');
  L.push(`- 失注確定 ${d.lossSummary.total} 件 / **改善可能(actionable)比率 ${pct(d.lossSummary.actionable_share)}**`);
  L.push('| 帰属 | 件数 | 意味 |');
  L.push('|---|---|---|');
  const attrMeaning = { L_TIMING: '時期相違→再スケジュール', L_ICP: 'ICP不適合→リスト条件是正', L_EXOGENOUS: '外生→除外/休眠', C_PITCH: '訴求→切り返し整備', PRODUCT: '機能→開発FB', PENDING: '保留→ナーチャリング', OTHER: '要再分類' };
  for (const a of d.lossSummary.by_attribution) L.push(`| ${a.key} | ${a.count} | ${attrMeaning[a.key] || ''} |`);
  L.push('');
  L.push('**改善アクション（理由別）**');
  L.push('| 失注理由 | 件数 | 帰属 | アクション |');
  L.push('|---|---|---|---|');
  for (const a of d.lossSummary.actions.slice(0, 10)) L.push(`| ${a.reason} | ${a.count} | ${a.attribution} | ${a.action} |`);
  L.push('');
  L.push('## 5. 再活性化タイミング（今月架電すべきリード）');
  L.push(`- 優先度>0 の再活性化候補: **${d.react.length.toLocaleString()}** 件（検討時期・更新月・次アクション日・失注経過で採点）`);
  L.push('- → data/gchain/v2/reactivation-queue.csv（優先度降順・PIIローカル限定）');
  if (d.react.length) {
    const top = d.react[0];
    L.push(`- 最上位の根拠例: priority=${top.priority} [${top.reasons}]`);
  }
  L.push('');
  L.push('## 6. 行動規律（フォロー予定 vs 完了・育成PDCAの実体）');
  L.push('| 所有者 | 予定 | 完了 | 実行率 | overdue率 | 平均間隔(日) |');
  L.push('|---|---|---|---|---|---|');
  for (const r of d.disc.slice(0, 12)) L.push(`| ${r.owner || '(不明)'} | ${r.planned} | ${r.completed} | ${pct(r.follow_execution_rate)} | ${pct(r.overdue_rate)} | ${r.avg_interval_days ?? '—'} |`);
  L.push('');
  L.push('## 7. 所見');
  L.push('- 会話質を捨てても、**接続の最適化・アポが出るセグメントの特定・失注の構造的改善・再活性化の優先付け・フォロー規律**は全て回る。');
  L.push('- 最大の資産は「架電済リードの成果ラベル×構造化特徴」= 教師データ。これで未架電/将来リストをスコアし、リスト作成システムに還元する（設計 原則9）。');
  L.push('- 次アクション: 上位リフトのソース/セグメントをリスト条件へ反映 → 再活性化キューを今月架電 → 失注actionable分を理由別アクションで潰す。');
  return L.join('\n');
}
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

if (require.main === module) main();
module.exports = { main };
