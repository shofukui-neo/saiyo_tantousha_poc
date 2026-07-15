'use strict';
/* @deprecated v2.0(MiiTel非依存)で廃止: 二枠サンプリングはtranscript前提。設計 docs/g-chain-os-v2.0-structured-only.md §9。参照用に保持(barrel除外)。 */
/**
 * G-Chain OS v1.5 — 文字起こし二枠サンプリング（詳細設計書 §6, baseline §1.2）。
 *
 * METRIC_SAMPLE: E2成立通話から無作為・裁量ゼロ（決定的hash昇順の上位N）。KPI/実験の正式分母。
 * DIAGNOSTIC_PRIORITY: METRIC除外後の残りから優先抽出。診断/コーチング用。
 * official_metric_eligible = observability=FULL AND selection∈{METRIC_SAMPLE,BOTH}。
 * 純関数（外部I/O無し・seed固定で再現可能 → AT-1 seed再現性）。
 */

const { stableHash32 } = require('./normalize');

const DEFAULT_CAP = 10;
const DEFAULT_METRIC = 7;
const DEFAULT_DIAGNOSTIC = 3;

/** 決定的選定キー（詳細§6.1）: hash(source_event_id + call_date) 昇順。 */
function metricKey(call) {
  return stableHash32(String(call.source_event_id || call.call_id || '') + '|' + String(call.call_date || ''));
}

/**
 * 診断優先スコア（詳細§6.1）: アポ・打診到達失注・未知パターンを優先。
 * 高いほど優先。決定的（乱数不使用）。
 */
function diagnosticScore(call) {
  let s = 0;
  if (call.is_appointment) s += 100;
  if (call.reached_proposal_but_lost) s += 60;
  if (call.is_novel_pattern) s += 30;
  return s;
}

/**
 * 二枠選定（詳細§6.1）。
 * input:
 *   e2Calls: E2成立通話配列（各 {call_id, source_event_id, call_date, is_appointment, reached_proposal_but_lost, is_novel_pattern, experiment_tag}）
 *   config: { cap, metricSize, diagnosticSize }
 * 返り値: { selections: Map<call_id, selection_type>, metric:[call_id], diagnostic:[call_id] }
 * selection_type ∈ {METRIC_SAMPLE, DIAGNOSTIC_PRIORITY, BOTH}
 */
function selectTranscripts(e2Calls, config) {
  const cfg = config || {};
  const metricSize = cfg.metricSize != null ? cfg.metricSize : DEFAULT_METRIC;
  const diagnosticSize = cfg.diagnosticSize != null ? cfg.diagnosticSize : DEFAULT_DIAGNOSTIC;

  // 実験対象は優先（原則両群全件 FULL・§6.1）→ METRIC に必ず含める
  const experimentCalls = e2Calls.filter((c) => c.experiment_tag);
  const experimentIds = new Set(experimentCalls.map((c) => c.call_id));

  // 枠1: METRIC（無作為・裁量ゼロ・決定的hash昇順）
  const byKey = [...e2Calls].sort((a, b) => {
    const ka = metricKey(a), kb = metricKey(b);
    if (ka !== kb) return ka - kb;
    return String(a.call_id) < String(b.call_id) ? -1 : 1; // 決定的タイブレーク
  });
  const metricSet = new Set(experimentIds); // 実験は無条件で
  for (const c of byKey) {
    if (metricSet.size >= metricSize) break;
    metricSet.add(c.call_id);
  }

  // 枠2: DIAGNOSTIC（METRIC除外後の残りから優先スコア上位）
  const remaining = e2Calls.filter((c) => !metricSet.has(c.call_id));
  remaining.sort((a, b) => {
    const d = diagnosticScore(b) - diagnosticScore(a);
    if (d !== 0) return d;
    return metricKey(a) - metricKey(b); // 決定的タイブレーク
  });
  const diagnosticSet = new Set();
  for (const c of remaining) {
    if (diagnosticSet.size >= diagnosticSize) break;
    if (diagnosticScore(c) <= 0) break; // 診断価値の無い通話は選ばない
    diagnosticSet.add(c.call_id);
  }

  // 選定タイプの割当（無作為枠に診断価値もあれば BOTH）
  const selections = new Map();
  for (const c of e2Calls) {
    const inMetric = metricSet.has(c.call_id);
    const inDiag = diagnosticSet.has(c.call_id);
    const diagnosticWorthy = diagnosticScore(c) > 0;
    if (inMetric && diagnosticWorthy) selections.set(c.call_id, 'BOTH');
    else if (inMetric) selections.set(c.call_id, 'METRIC_SAMPLE');
    else if (inDiag) selections.set(c.call_id, 'DIAGNOSTIC_PRIORITY');
  }

  return {
    selections,
    metric: [...metricSet],
    diagnostic: [...diagnosticSet],
  };
}

/** official_metric_eligible（詳細§6.2）: 率分母のゲート。 */
function isOfficialEligible(observability, selectionType) {
  return observability === 'FULL' && (selectionType === 'METRIC_SAMPLE' || selectionType === 'BOTH');
}

/** metric_coverage（詳細§6.3）: 品質KPI。 */
function metricCoverage(metricAcquired, e2Total) {
  if (!e2Total) return null;
  return metricAcquired / e2Total;
}

module.exports = {
  DEFAULT_CAP, DEFAULT_METRIC, DEFAULT_DIAGNOSTIC,
  metricKey, diagnosticScore, selectTranscripts, isOfficialEligible, metricCoverage,
};
