'use strict';
/**
 * G-Chain OS v1.5 — KPI集計（詳細設計書 §9, baseline §10）。
 *
 * 大原則:
 *  - UNKNOWN と NOT_ELIGIBLE は常に分母外。
 *  - 会話系(E3〜E6)は official_metric_eligible=true ∧ purposeセグメント内。
 *  - 分母規則は officialDenominator に集約し KPI 間のドリフトを防ぐ（詳細§9.1）。
 * 純関数（外部I/O無し）。call 行は 01 の1レコード形。
 */

const IN_DENOM_STATES = new Set(['TRUE', 'FALSE']); // UNKNOWN/NOT_ELIGIBLE は常に除外

/** 状態が分母に入るか（UNKNOWN/NOT_ELIGIBLE を弾く共通ゲート）。 */
function stateInDenom(state) {
  return IN_DENOM_STATES.has(state);
}

/**
 * 会話系イベントの official 分母資格（詳細§9.1 の集約述語）。
 * conversationEvent=true の KPI は official_metric_eligible を要求する。
 */
function officialDenominator(call, eventCode, opts) {
  const conversation = new Set(['E3', 'E4', 'E5', 'E6']);
  if (conversation.has(eventCode) && !call.official_metric_eligible) return false;
  if (opts && opts.purpose && call.purpose_planned !== opts.purpose) return false;
  return true;
}

/** 汎用レート: 分母メンバ判定 + 分子判定。UNKNOWN/NOT_ELIGIBLE は inDenom 側で除外。 */
function computeRate(calls, inDenom, isNumerator) {
  let num = 0, den = 0;
  for (const c of calls) {
    if (!inDenom(c)) continue;
    den++;
    if (isNumerator(c)) num++;
  }
  return { numerator: num, denominator: den, value: den ? num / den : null };
}

const st = (c, e) => c[e.toLowerCase() + '_state'];

/**
 * KPIレジストリ（詳細§9 表）。各KPI: { inDenom(call,opts), numerator(call) }。
 * E率系は official_metric_eligible をゲート。opts.purpose でセグメント。
 */
const KPI = {
  // 接続: E2率 = E2/E0（全通話・official不要）
  e2_rate: {
    inDenom: (c) => stateInDenom(st(c, 'E0')),
    numerator: (c) => st(c, 'E2') === 'TRUE',
  },
  // 会話: E3率 = E3(TRUE)/E2（official∧purpose）
  e3_rate: {
    inDenom: (c, o) => st(c, 'E2') === 'TRUE' && officialDenominator(c, 'E3', o),
    numerator: (c) => st(c, 'E3') === 'TRUE',
  },
  // E4率 = E4(TRUE)/(E4∈{T,F})（official∧purpose）
  e4_rate: {
    inDenom: (c, o) => stateInDenom(st(c, 'E4')) && officialDenominator(c, 'E4', o),
    numerator: (c) => st(c, 'E4') === 'TRUE',
  },
  // E5率 = E5(TRUE, b以上)/(E5∈{T,F})
  e5_rate: {
    inDenom: (c, o) => stateInDenom(st(c, 'E5')) && officialDenominator(c, 'E5', o),
    numerator: (c) => st(c, 'E5') === 'TRUE',
  },
  // 打診率 = E6/(E5∧opportunity=yes)（適格性補正）
  proposal_rate: {
    inDenom: (c, o) => st(c, 'E5') === 'TRUE' && c.proposal_opportunity === 'yes' && officialDenominator(c, 'E6', o),
    numerator: (c) => st(c, 'E6') === 'TRUE',
  },
  // 相手質問発生率 = customer_question/E3
  question_rate: {
    inDenom: (c, o) => st(c, 'E3') === 'TRUE' && officialDenominator(c, 'E3', o),
    numerator: (c) => !!c.customer_question,
  },
  // 成果: E7率
  e7_rate: {
    inDenom: (c, o) => stateInDenom(st(c, 'E7')) && officialDenominator(c, 'E7', o),
    numerator: (c) => st(c, 'E7') === 'TRUE',
  },
  // 監視: purpose_changed率（全通話）
  purpose_changed_rate: {
    inDenom: () => true,
    numerator: (c) => c.purpose_changed === true,
  },
  // 品質: UNKNOWN率（transcript対象イベントのUNKNOWN比率・E4基準）
  unknown_rate: {
    inDenom: (c) => st(c, 'E2') === 'TRUE',
    numerator: (c) => st(c, 'E4') === 'UNKNOWN',
  },
};

/** 1 KPI を calls に対し集計（opts.purpose でセグメント）。 */
function runKpi(name, calls, opts) {
  const k = KPI[name];
  if (!k) throw new Error(`unknown KPI: ${name}`);
  return computeRate(calls, (c) => k.inDenom(c, opts), k.numerator);
}

/**
 * 実施率 = held / (created済E7のうちoutcome確定分)（詳細§9, baseline §2.6）。
 * pending(窓内)=UNKNOWN は分母外。
 * e7records: [{ next_step_disposition, next_step_outcome, e8_resolved }]
 * e8_resolved は event-engine.resolveE8ForRecord の結果（TRUE/FALSE/UNKNOWN）。
 */
function heldRate(e7records) {
  let num = 0, den = 0;
  for (const r of e7records) {
    if (r.next_step_disposition !== 'created') continue;
    if (r.e8_resolved === 'UNKNOWN') continue; // pending窓内は確定待ち → 分母外
    den++;
    if (r.next_step_outcome === 'held') num++;
  }
  return { numerator: num, denominator: den, value: den ? num / den : null };
}

/**
 * D2ファネル（詳細§9）: 各段の TRUE/FALSE/UNKNOWN/NOT_ELIGIBLE 分布。
 * UNKNOWN帯をグレー表示するための集計。
 */
function funnel(calls, eventCodes) {
  const codes = eventCodes || ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'];
  const out = {};
  for (const e of codes) {
    const dist = { TRUE: 0, FALSE: 0, UNKNOWN: 0, NOT_ELIGIBLE: 0 };
    for (const c of calls) {
      const s = st(c, e);
      if (dist[s] != null) dist[s]++;
    }
    out[e] = dist;
  }
  return out;
}

module.exports = {
  IN_DENOM_STATES, stateInDenom, officialDenominator, computeRate,
  KPI, runKpi, heldRate, funnel,
};
