'use strict';
/**
 * G-Chain OS v1.5 — 実験マネージャ（詳細設計書 §10, baseline §11）。
 *
 * 原則: 一実験一変数／ブロック割付(hash固定・週替わり禁止)／判定日まで効果指標マスク／
 *       ITT主(purpose_planned基準)・PP併記。
 * 純関数（外部I/O無し・now は引数注入）。
 */

const { stableHash32 } = require('./normalize');
const { computeRate } = require('./kpi');

const ARMS = Object.freeze(['A', 'B']);

/**
 * 決定的アーム割付（詳細§10.1）。hash(uid or call_id) % 2。週替わり禁止 = 入力に週を含めない。
 * exp_id を混ぜ実験間で割付を独立させる。
 */
function assignArm(unitId, expId) {
  const h = stableHash32(String(expId || '') + '|' + String(unitId));
  return ARMS[h % 2];
}

/** ブロックキー（詳細§10.1）: 時間帯 × 新規/追客。業界はセル数確認後に追加。 */
function blockKey(call) {
  const band = timeBand(call.call_at);
  const seg = (call.purpose_planned === 'NEW_PROSPECTING') ? 'new' : 'followup';
  return `${band}#${seg}`;
}

function timeBand(callAt) {
  if (!callAt) return 'unk';
  const m = String(callAt).match(/\b(\d{1,2}):/);
  const h = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(h)) return 'unk';
  if (h < 11) return 'am';
  if (h < 14) return 'noon';
  if (h < 17) return 'pm';
  return 'eve';
}

/** マスク判定（詳細§10.1）: 判定日前は効果指標を隠す。 */
function isMasked(nowDate, decisionDate) {
  if (!decisionDate) return true;
  return String(nowDate) < String(decisionDate);
}

/**
 * 忠実度検知（詳細§10.2 実験#001）: transcript から give_first を機械検知。
 * B腕は give_first_detected=true, A腕は false が忠実。
 * 返り値: { compliant, reason }
 */
function checkFidelity(call, expectedArm) {
  const give = !!call.give_first_detected;
  if (expectedArm === 'B') return { compliant: give, reason: give ? 'ok' : 'B_missing_give' };
  if (expectedArm === 'A') return { compliant: !give, reason: give ? 'A_has_give_contamination' : 'ok' };
  return { compliant: true, reason: 'na' };
}

/** 割付汚染率（AT-5 <5%）: 忠実度非適合の割合。 */
function contaminationRate(assignedCalls) {
  let bad = 0;
  for (const c of assignedCalls) {
    if (!checkFidelity(c, c.assigned_arm).compliant) bad++;
  }
  return assignedCalls.length ? bad / assignedCalls.length : 0;
}

/**
 * 実験判定（詳細§10.1, baseline §11）。ITT主・PP併記。判定日前はマスク。
 * input:
 *   calls: 割付済 call 配列（各 c.assigned_arm ∈ {A,B}）
 *   metric: { inDenom(call), numerator(call) }  一次指標の分母/分子述語
 *   spec: { decision_date }
 *   nowDate
 * 返り値: マスク中は {masked:true}。判定日以降は ITT/PP のアーム別レートと差分。
 */
function decideExperiment(calls, metric, spec, nowDate) {
  if (isMasked(nowDate, spec.decision_date)) {
    return { masked: true, decision_date: spec.decision_date };
  }
  const armCalls = (arm) => calls.filter((c) => c.assigned_arm === arm);

  // ITT: 割付通り全件（purpose_planned 基準は metric.inDenom 側で担保）
  const ittA = computeRate(armCalls('A'), metric.inDenom, metric.numerator);
  const ittB = computeRate(armCalls('B'), metric.inDenom, metric.numerator);

  // PP: 忠実度適合のみ
  const compliant = (arm) => armCalls(arm).filter((c) => checkFidelity(c, arm).compliant);
  const ppA = computeRate(compliant('A'), metric.inDenom, metric.numerator);
  const ppB = computeRate(compliant('B'), metric.inDenom, metric.numerator);

  return {
    masked: false,
    decision_date: spec.decision_date,
    itt: { A: ittA, B: ittB, diff: diff(ittB.value, ittA.value) },
    pp: { A: ppA, B: ppB, diff: diff(ppB.value, ppA.value) },
    contamination_rate: contaminationRate(calls),
  };
}

function diff(b, a) {
  if (b == null || a == null) return null;
  return Math.round((b - a) * 1000) / 1000;
}

module.exports = {
  ARMS, assignArm, blockKey, timeBand, isMasked,
  checkFidelity, contaminationRate, decideExperiment,
};
