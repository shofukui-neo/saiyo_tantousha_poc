'use strict';
/**
 * G-Chain OS v1.5 — Q評価合成（詳細設計書 §8.2, baseline §7.2）。
 *
 * 規則:
 *  - 項目スコア ∈ {2,1,0,NA}。NAは0点扱いしない（分母から除外）。
 *  - telemetry欠損の時間系 → NA_TELEMETRY_MISSING（NA扱い）。
 *  - 適用可能満点 < 16 → Q_INSUFFICIENT（非表示）。
 *  - Q_raw = 100 * Σ得点 / 適用可能満点。
 *  - 主表示はセクション別サブスコア。
 *  - 共通項目法: 両期間で適用された項目のみ再計算（分母固定）。
 *  - mastered は優先度除外のみ。総合・共通項目法には残す（回帰番兵）。
 *  - 重大違反 cap C0/C1/C2/C3。cap前後の両スコア保存。
 * 純関数（外部I/O無し）。
 */

const NA_VALUES = new Set(['NA', 'NA_TELEMETRY_MISSING']);
const ITEM_MAX = 2;
const Q_MIN_APPLICABLE = 16; // 適用可能満点の下限
const SECTIONS = Object.freeze(['A', 'B', 'C', 'D', 'E']); // 冒頭/質問/価値/打診/スタンス

function isNA(score) {
  return NA_VALUES.has(score);
}

function isApplied(item) {
  return !isNA(item.score) && item.score != null;
}

/**
 * Q合成（詳細§8.2）。
 * items: [{ id, section, score(2|1|0|'NA'|'NA_TELEMETRY_MISSING'), mastered?:bool }]
 * 返り値:
 *  { status:'OK'|'Q_INSUFFICIENT', q_raw, achieved, applicable_max,
 *    subscores:{A..E}, applied_ids:[], na_ids:[] }
 */
function computeQ(items) {
  const applied = items.filter(isApplied);
  const applicable_max = applied.length * ITEM_MAX;
  const achieved = applied.reduce((s, it) => s + Number(it.score), 0);

  const sectionAgg = {};
  for (const sec of SECTIONS) sectionAgg[sec] = { achieved: 0, max: 0 };
  for (const it of applied) {
    const sec = it.section;
    if (sectionAgg[sec]) {
      sectionAgg[sec].achieved += Number(it.score);
      sectionAgg[sec].max += ITEM_MAX;
    }
  }
  const subscores = {};
  for (const sec of SECTIONS) {
    const a = sectionAgg[sec];
    subscores[sec] = a.max ? round1(100 * a.achieved / a.max) : null;
  }

  if (applicable_max < Q_MIN_APPLICABLE) {
    return {
      status: 'Q_INSUFFICIENT',
      q_raw: null, achieved, applicable_max, subscores,
      applied_ids: applied.map((i) => i.id),
      na_ids: items.filter((i) => isNA(i.score)).map((i) => i.id),
    };
  }
  return {
    status: 'OK',
    q_raw: round1(100 * achieved / applicable_max),
    achieved, applicable_max, subscores,
    applied_ids: applied.map((i) => i.id),
    na_ids: items.filter((i) => isNA(i.score)).map((i) => i.id),
  };
}

/**
 * 重大違反 cap（詳細§8.2, baseline §7.2）。cap前後を両方返す。
 * violations: Set|Array<'C0'|'C1'|'C2'|'C3'>
 * qResult: computeQ の返り値
 * aScore: A軸(資産化)の値（C2 で 0 強制）
 */
function applyCaps(qResult, violations, aScore) {
  const v = new Set(violations || []);
  const preQ = qResult.q_raw;
  let postQ = preQ;
  const flags = { teacher_excluded: false, pp_excluded: false, itt_retained: false, a_forced_zero: false };

  if (v.has('C0')) { postQ = capAt(postQ, 49); flags.teacher_excluded = true; }
  if (v.has('C1')) { postQ = capAt(postQ, 69); }
  if (v.has('C2')) { flags.a_forced_zero = true; }
  if (v.has('C3')) { flags.pp_excluded = true; flags.itt_retained = true; }

  return {
    caps_applied: [...v].sort(),
    q_pre_cap: preQ,
    q_post_cap: postQ,
    a_pre_cap: aScore,
    a_post_cap: flags.a_forced_zero ? 0 : aScore,
    ...flags,
  };
}

function capAt(q, ceil) {
  if (q == null) return q;
  return Math.min(q, ceil);
}

/**
 * 共通項目法（詳細§8.2）: 両期間で「適用された」項目のみで両スコア再計算。
 * mastered も残す（分母を動かさない）。
 * itemsA, itemsB: 同一 rubric の項目配列（id で対応）。
 * 返り値: { shared_ids, a:{...computeQ}, b:{...computeQ} }
 */
function commonItemMethod(itemsA, itemsB) {
  const appliedA = new Set(itemsA.filter(isApplied).map((i) => i.id));
  const appliedB = new Set(itemsB.filter(isApplied).map((i) => i.id));
  const shared = [...appliedA].filter((id) => appliedB.has(id));
  const sharedSet = new Set(shared);
  const filt = (items) => items.filter((i) => sharedSet.has(i.id));
  return {
    shared_ids: shared,
    a: computeQ(filt(itemsA)),
    b: computeQ(filt(itemsB)),
  };
}

/**
 * 優先度対象項目（mastered を除外・詳細§8.2）。総合には残すが、コーチング優先度表示から外す。
 */
function priorityItems(items) {
  return items.filter((i) => !i.mastered);
}

/**
 * MORE 優先度（baseline §7.3）: frequency × gate_loss × controllability × confidence。
 */
function morePriority(f) {
  return Number(f.frequency || 0) * Number(f.gate_loss || 0)
    * Number(f.controllability || 0) * Number(f.confidence || 0);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = {
  NA_VALUES, ITEM_MAX, Q_MIN_APPLICABLE, SECTIONS,
  isNA, isApplied, computeQ, applyCaps, commonItemMethod, priorityItems, morePriority,
};
