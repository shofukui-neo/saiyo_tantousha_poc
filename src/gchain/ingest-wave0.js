'use strict';
/**
 * G-Chain OS v1.5 — Wave 0 実データ取込・分析ドライバ（詳細設計書 §2, §5, §9, §13 AT-0）。
 *
 * 入力（調査対象）:
 *   BALES: data/BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv（分析主軸・コール結果/次アクション/商談）
 *   SF:    data/セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv（全リード・既存被り突合）
 *   既存顧客: data/MOCHICAの既存顧客リスト - mochica-companies-list.csv（除外マスタ）
 * MiiTel: 無し → 会話質(E3-E6)は UNKNOWN（分母外）。接続ファネル/E7/E8 を構造化データで確定。
 *
 * 出力: data/gchain/01_call_events.csv・12_quality.json・report.md
 * 実行: node src/gchain/ingest-wave0.js
 */
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../csv');
const { normalize, canonical, eventEngine, kpi } = require('./index');
const balesMap = require('./bales-map');

const DATA = path.join(__dirname, '..', '..', 'data');
const OUT = path.join(DATA, 'gchain');
const F_BALES = path.join(DATA, 'BALESCLOUDの既存リスト - 202607062007_leadList_utf-8.csv');
const F_SF = path.join(DATA, 'セールスフォースMOCHICA参照 - 全てのリードSitoke突合用.csv');
const F_CUST = path.join(DATA, 'MOCHICAの既存顧客リスト - mochica-companies-list.csv');

const NG_TYPES_BLOCK = new Set([
  '全社アプローチ禁止（全事業部アプローチ禁止）', '取引停止', '取引制限あり', 'ネオキャリア側窓口一本化',
]);

function readCsvRecords(file, headerRowFinder) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  let hi = 0;
  if (headerRowFinder) hi = rows.findIndex(headerRowFinder);
  if (hi < 0) hi = 0;
  const head = rows[hi];
  const recs = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const o = {};
    head.forEach((h, i) => { o[h] = rows[r][i]; });
    recs.push(o);
  }
  return { head, recs };
}

function buildExistingCustomerSet() {
  const { recs } = readCsvRecords(F_CUST);
  const set = new Set();
  for (const r of recs) {
    const nm = normalize.normCompanyName(r['法人名'] || '');
    if (nm && nm !== '削除') set.add(nm);
  }
  return set;
}

function buildSfLeadSet() {
  // SF はプリアンブル付き。会社名らしき列を含む最初のヘッダ行を探す。
  try {
    const { head, recs } = readCsvRecords(F_SF, (row) => row.some((c) => /会社|company|取引先|リード名|氏名/.test(String(c || ''))));
    const nameCol = head.find((h) => /会社名|取引先名|会社|リード名/.test(String(h || '')));
    const set = new Set();
    if (nameCol) for (const r of recs) { const nm = normalize.normCompanyName(r[nameCol] || ''); if (nm) set.add(nm); }
    return { set, nameCol, count: recs.length };
  } catch (e) {
    return { set: new Set(), nameCol: null, count: 0, error: String(e) };
  }
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const custSet = buildExistingCustomerSet();
  const sf = buildSfLeadSet();

  const { recs } = readCsvRecords(F_BALES);
  const agg = {
    total_leads: recs.length,
    called: 0, not_called: 0,
    ng_blocked: 0, existing_customer_overlap: 0, sf_overlap: 0,
    result_dist: {}, outcome_dist: {}, loss_reason_major: {},
    recruit_size: {},
    e7_appointment: 0, e7_held: 0, e7_pending: 0,
    e7_held_deal: 0, e7_held_action_only: 0,
    hearing_rows: 0,
  };
  const callRows = [];
  const funnelCalls = []; // resolveCall 結果（called のみ）

  recs.forEach((rec, idx) => {
    const company = (rec['会社情報：会社名'] || '').trim();
    const normName = normalize.normCompanyName(company);
    const callId = `BAL-${rec['システム管理情報：ID'] || idx}`;
    const result = (rec['コール結果1：結果'] || '').trim();
    const stage = (rec['リード関連情報：最終リードステージ'] || '').trim();
    const ng = (rec['カスタム情報：アプローチ禁止の種類'] || '').trim();
    const size = (rec['カスタム情報：採用人数(選択リスト)'] || '').trim();

    agg.outcome_dist[stage] = (agg.outcome_dist[stage] || 0) + 1;
    if (size) agg.recruit_size[size] = (agg.recruit_size[size] || 0) + 1;
    if (ng && NG_TYPES_BLOCK.has(ng)) agg.ng_blocked++;
    if (normName && custSet.has(normName)) agg.existing_customer_overlap++;
    if (normName && sf.set.has(normName)) agg.sf_overlap++;

    if (!result) { agg.not_called++; return; }
    agg.called++;
    agg.result_dist[result] = (agg.result_dist[result] || 0) + 1;
    if (result === 'ヒアリング成功') agg.hearing_rows++;

    const lossMajor = (rec['カスタム情報：失注商談失注理由大'] || '').trim();
    if (lossMajor) agg.loss_reason_major[lossMajor] = (agg.loss_reason_major[lossMajor] || 0) + 1;

    // 観測生成 → canonical → resolveCall
    const parsed = balesMap.toObservations(rec, { callId, observationBase: `${callId}-obs` });
    const deduped = canonical.dedupeObservations(parsed.observations, { bucketSec: 30 });
    const canon = deduped.filter((o) => o.is_canonical);
    const createdE7 = balesMap.createdE7Records(parsed, rec, nowSec);

    const resolved = eventEngine.resolveCall({
      call_id: callId,
      event_observability: 'PARTIAL', // 構造化のみ・transcript無し
      canonicalEvents: canon,
      createdE7Records: createdE7,
      flags: { agent_spoke: parsed.meta.e2 === true, next_step_conceivable: !parsed.meta.invalid },
      nowSec,
      e8WindowDays: 30,
    });

    // コールのみ/番号系の E1/E2 は真に不明 → UNKNOWN 補正（構造化FALSEの過剰付与を防ぐ）
    if (result === 'コールのみ') { resolved.states.E1 = 'UNKNOWN'; resolved.states.E2 = 'UNKNOWN'; }

    // E7/E8 集計
    if (createdE7.length) {
      agg.e7_appointment++;
      const dealCreated = (rec['商談1：商談作成日時'] || '').trim();
      if (createdE7[0].next_step_outcome === 'held') {
        agg.e7_held++;
        if (dealCreated) agg.e7_held_deal++; else agg.e7_held_action_only++;
      } else agg.e7_pending++;
    }

    const row = {
      call_id: callId, company, norm_company: normName,
      call_at: parsed.startedAt, result, stage,
      e0: resolved.states.E0, e1: resolved.states.E1, e2: resolved.states.E2,
      e3: resolved.states.E3, e4: resolved.states.E4, e5: resolved.states.E5,
      e6: resolved.states.E6, e7: resolved.states.E7, e8: resolved.states.E8,
      max_event: resolved.max_event,
      ng: ng && NG_TYPES_BLOCK.has(ng) ? 'BLOCK' : '',
      existing_customer: normName && custSet.has(normName) ? 1 : 0,
      recruit_size: size,
    };
    callRows.push(row);
    funnelCalls.push({
      e0_state: resolved.states.E0, e1_state: resolved.states.E1, e2_state: resolved.states.E2,
      e3_state: resolved.states.E3, e4_state: resolved.states.E4, e7_state: resolved.states.E7,
      official_metric_eligible: false, // MiiTel無し → official会話KPIは算出不能
      purpose_planned: 'NEW_PROSPECTING',
    });
  });

  // KPI（構造化で算出可能なもの）
  const e2rate = kpi.runKpi('e2_rate', funnelCalls);
  const funnel = kpi.funnel(funnelCalls, ['E0', 'E1', 'E2', 'E3', 'E4', 'E7']);
  const quality = {
    total_leads: agg.total_leads, called: agg.called, not_called: agg.not_called,
    metric_coverage: 0, // MiiTel欠損
    e4_unknown_rate: agg.called ? (funnel.E4.UNKNOWN / agg.called) : null,
    match_universe: { existing_customers: custSet.size, sf_leads: sf.count, sf_name_col: sf.nameCol },
  };

  // 出力
  writeCsv(path.join(OUT, '01_call_events.csv'), callRows);
  fs.writeFileSync(path.join(OUT, '12_quality.json'), JSON.stringify(quality, null, 2));
  const report = buildReport(agg, e2rate, funnel, quality, sf);
  fs.writeFileSync(path.join(OUT, 'report.md'), report);
  console.log(report);
  console.log(`\n出力: ${path.relative(process.cwd(), OUT)}/ (01_call_events.csv ${callRows.length}行 / 12_quality.json / report.md)`);
}

function writeCsv(file, rows) {
  if (!rows.length) { fs.writeFileSync(file, ''); return; }
  const head = Object.keys(rows[0]);
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [head.join(',')];
  for (const r of rows) lines.push(head.map((h) => esc(r[h])).join(','));
  fs.writeFileSync(file, lines.join('\n'));
}

function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '—'; }
function topN(obj, n) { return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n); }

function buildReport(a, e2rate, funnel, q, sf) {
  const L = [];
  L.push('# G-Chain OS v1.5 — Wave 0 実データ分析レポート');
  L.push('');
  L.push('> 調査対象: BALES既存リスト / SF全リード / MOCHICA既存顧客。MiiTel文字起こしは無し。');
  L.push('> **MiiTel欠損のため会話質(E3-E6)は UNKNOWN=分母外**（仕様通り）。接続ファネル・E7/E8・成果を構造化データで確定。');
  L.push('');
  L.push('## 1. データ品質（12_データ品質）');
  L.push(`- 総リード: **${a.total_leads.toLocaleString()}** / うち架電済(コール結果あり): **${a.called.toLocaleString()}** / 未架電: ${a.not_called.toLocaleString()}`);
  L.push(`- metric_coverage: **0%**（MiiTel無し → 正式な会話KPIは算出不能）`);
  L.push(`- E4 UNKNOWN率: **${pct(funnel.E4.UNKNOWN, a.called)}**（会話内容が不可視 = 母集団問題の裏付け）`);
  L.push(`- 既存顧客突合ユニバース: ${q.match_universe.existing_customers}社 / SF全リード: ${sf.count.toLocaleString()}行(会社列: ${sf.nameCol || '未検出'})`);
  L.push('');
  L.push('## 2. 接続ファネル（E0→E1→E2・構造化・observability=PARTIAL）');
  L.push('| 段 | TRUE | FALSE | UNKNOWN | 通過率 |');
  L.push('|---|---|---|---|---|');
  for (const e of ['E0', 'E1', 'E2']) {
    const f = funnel[e];
    const denom = f.TRUE + f.FALSE;
    L.push(`| ${e} | ${f.TRUE} | ${f.FALSE} | ${f.UNKNOWN} | ${pct(f.TRUE, denom)} |`);
  }
  L.push(`- **E2率（担当接続/架電）= ${pct(e2rate.numerator, e2rate.denominator)}**（${e2rate.numerator}/${e2rate.denominator}）`);
  L.push('');
  L.push('## 3. コール結果分布');
  L.push('| 結果 | 件数 |');
  L.push('|---|---|');
  for (const [k, v] of topN(a.result_dist, 15)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('## 4. 成果（E7 次接点 / E8 実施）');
  L.push(`- アポ獲得(E7 meeting_confirmed): **${a.e7_appointment}** 件`);
  L.push(`- 商談作成あり(強い実施シグナル・E8 held): **${a.e7_held_deal}** 件 → 実施率 **${pct(a.e7_held_deal, a.e7_appointment)}**`);
  L.push(`- 次アクション完了のみ(弱い代替・要確認): ${a.e7_held_action_only} 件 / outcome未確定(pending): ${a.e7_pending} 件`);
  L.push(`  - ※「次アクション完了」は商談実施の弱い代替。商談作成の有無で強弱を分離（安易にheldと断定しない）`);
  L.push(`- ヒアリング成功(E4/E5をnoteで取得): ${a.hearing_rows} 件`);
  L.push('');
  L.push('## 5. アプローチ可否・既存被り（運用フィルタ）');
  L.push(`- アプローチ禁止(全社/取引停止/窓口一本化等): **${a.ng_blocked}** 社 → 架電対象から除外すべき`);
  L.push(`- 既存顧客(MOCHICA)との社名一致: **${a.existing_customer_overlap}** 社`);
  L.push(`- SF全リード一致: ${a.sf_overlap} 社`);
  L.push('');
  L.push('## 6. 最終リードステージ分布（Outcome軸）');
  L.push('| ステージ | 件数 |');
  L.push('|---|---|');
  for (const [k, v] of topN(a.outcome_dist, 12)) L.push(`| ${k || '(空)'} | ${v} |`);
  L.push('');
  if (Object.keys(a.loss_reason_major).length) {
    L.push('## 7. 失注理由大（L/C/S帰属の構造化ヒント）');
    L.push('| 理由 | 件数 |');
    L.push('|---|---|');
    for (const [k, v] of topN(a.loss_reason_major, 10)) L.push(`| ${k} | ${v} |`);
    L.push('');
  }
  L.push('## 8. 採用人数セグメント（MOCHICA ICP適合の母数）');
  L.push('| 採用人数 | 件数 |');
  L.push('|---|---|');
  for (const [k, v] of topN(a.recruit_size, 12)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('## 9. 所見');
  L.push('- **接続ファネルと成果は構造化データで完全に可視化できる**（E0-E2・E7・E8・失注理由・セグメント）。');
  L.push('- **会話の質(E3-E6)はMiiTel欠損で不可視（UNKNOWN）**。コーチング/LCS診断/実験#001を回すには文字起こし取込が前提。');
  L.push('- 次の一手: MiiTel文字起こしを二枠サンプリング(§1.2)で日次取込 → E3-E6 と Q採点が発火。それまでは L0(接続/成果)の運用に限定。');
  return L.join('\n');
}

if (require.main === module) main();
module.exports = { main, buildExistingCustomerSet, buildSfLeadSet, NG_TYPES_BLOCK };
