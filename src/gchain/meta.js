'use strict';
/**
 * G-Chain OS v1.5 — M層メタ評価・回帰ゲート（詳細設計書 §11, baseline §9）。
 *
 * 評価基準自体を仮説として淘汰する層。M1〜M5 とライフサイクル、回帰ゲート（切替の門）。
 * 純関数（外部I/O無し）。
 */

const MIN_ELIGIBLE_N = 30; // 有効レビュー（詳細§11.1）

/**
 * M1: 改善余地×変動性（詳細§11.1）。
 * scores: 数値配列（当該項目の採点、NA除外済み）。target: 目標値。prevMean: 前週平均。
 * 返り値: { eligible_n, mean, variance, weekly_change, target_gap, verdict }
 *   verdict: 'mastered'(全満点=回帰番兵) | 'top_priority'(全0) | 'definition_suspect'(全NA/n=0) | 'active'
 */
function m1(scores, opts) {
  const o = opts || {};
  const vals = scores.filter((v) => typeof v === 'number');
  const n = vals.length;
  if (n === 0) return { eligible_n: 0, mean: null, variance: null, weekly_change: null, target_gap: null, verdict: 'definition_suspect' };
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const max = o.item_max != null ? o.item_max : 2;
  let verdict = 'active';
  if (vals.every((v) => v === max)) verdict = 'mastered';       // 回帰番兵（休眠にしない）
  else if (vals.every((v) => v === 0)) verdict = 'top_priority'; // 最優先（休眠禁止）
  return {
    eligible_n: n,
    mean: round3(mean),
    variance: round3(variance),
    weekly_change: o.prev_mean != null ? round3(mean - o.prev_mean) : null,
    target_gap: o.target != null ? round3(o.target - mean) : null,
    verdict,
  };
}

/**
 * M2: 判定信頼性 — 二次重み付きκ（詳細§11.1）。
 * ratingsA, ratingsB: 対応する整数評点配列（NA は事前に対で除外）。
 * カテゴリ数は maxCat+1（既定 0,1,2 の3カテゴリ）。
 */
function weightedKappa(ratingsA, ratingsB, maxCat) {
  const K = (maxCat != null ? maxCat : 2) + 1;
  const n = ratingsA.length;
  if (n === 0 || n !== ratingsB.length) return null;

  const O = Array.from({ length: K }, () => new Array(K).fill(0));
  const rowMarg = new Array(K).fill(0);
  const colMarg = new Array(K).fill(0);
  for (let i = 0; i < n; i++) {
    const a = ratingsA[i], b = ratingsB[i];
    if (a < 0 || a >= K || b < 0 || b >= K) return null;
    O[a][b]++; rowMarg[a]++; colMarg[b]++;
  }
  // 二次重み W[i][j] = (i-j)^2 / (K-1)^2
  const denom = (K - 1) ** 2;
  let numObs = 0, numExp = 0;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      const w = ((i - j) ** 2) / denom;
      const eij = (rowMarg[i] * colMarg[j]) / n;
      numObs += w * O[i][j];
      numExp += w * eij;
    }
  }
  if (numExp === 0) return 1; // 完全一致（分散無し）
  return round3(1 - numObs / numExp);
}

/**
 * C0〜C3 の生涯信頼性（詳細§11.1）: 再現率100%・偽陽性≤5%。
 * cases: [{ gold_violation:bool, detected_violation:bool }]（当該Cコードのみ）
 * 返り値: { recall, false_positive_rate, pass }
 */
function capReliability(cases) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const c of cases) {
    if (c.gold_violation && c.detected_violation) tp++;
    else if (c.gold_violation && !c.detected_violation) fn++;
    else if (!c.gold_violation && c.detected_violation) fp++;
    else tn++;
  }
  const recall = (tp + fn) ? tp / (tp + fn) : 1;
  const fpr = (fp + tn) ? fp / (fp + tn) : 0;
  return { recall: round3(recall), false_positive_rate: round3(fpr), pass: recall >= 1 && fpr <= 0.05 };
}

/**
 * M4a: actionability（詳細§11.1）— MORE選出→実行可能次行動の生成率。
 * items: [{ more_selected:bool, actionable_next_action:bool }]
 */
function actionability(items) {
  const sel = items.filter((i) => i.more_selected);
  if (!sel.length) return null;
  const ok = sel.filter((i) => i.actionable_next_action).length;
  return round3(ok / sel.length);
}

/**
 * M4b 昇格判定（詳細§11.1）: proximal≥最小実務差 ∧ downstream2窓連続同方向 ∧ confounded=false。
 * res: { proximal_effect, min_practical_effect, downstream:[w1_dir, w2_dir], confounded }
 */
function m4bPromote(res) {
  const proximalOk = Number(res.proximal_effect) >= Number(res.min_practical_effect);
  const d = res.downstream || [];
  const downstreamOk = d.length >= 2 && d[0] != null && d[0] === d[1] && d[0] !== 0;
  return proximalOk && downstreamOk && res.confounded === false;
}

/**
 * M5: コスト（詳細§11.1）。NA率・保留率・所要。
 * items: [{ na:bool, hold:bool, duration_sec:number }]
 */
function m5(items) {
  const n = items.length || 1;
  const na = items.filter((i) => i.na).length / n;
  const hold = items.filter((i) => i.hold).length / n;
  const dur = items.reduce((a, b) => a + (Number(b.duration_sec) || 0), 0) / n;
  return { na_rate: round3(na), hold_rate: round3(hold), avg_duration_sec: round3(dur) };
}

/**
 * 回帰ゲート（詳細§11.3, baseline §9.3）— 切替の門。回帰未実施の切替禁止。
 * mode: 'prompt_minor'（ゴールド20）| 'model_or_criteria'（ゴールド60）
 * metrics: { gold_n, item_agreement, more_agreement, c_detection_diff, mae, e_agreement }
 * 返り値: { pass, mode, required, failures:[] }
 */
function regressionGate(mode, metrics) {
  const failures = [];
  const req = mode === 'model_or_criteria'
    ? { gold_n: 60, item_agreement: 0.95, more_agreement: 0.80, c_detection_diff: 0, mae_max: 8, e_agreement: 0.95 }
    : { gold_n: 20, item_agreement: 0.90, more_agreement: 0.80, c_detection_diff: 0 };

  if ((metrics.gold_n || 0) < req.gold_n) failures.push(`gold_n<${req.gold_n}`);
  if ((metrics.item_agreement || 0) < req.item_agreement) failures.push(`item_agreement<${req.item_agreement}`);
  if ((metrics.more_agreement || 0) < req.more_agreement) failures.push(`more_agreement<${req.more_agreement}`);
  if (Math.abs(metrics.c_detection_diff || 0) > req.c_detection_diff) failures.push('c_detection_diff!=0');
  if (mode === 'model_or_criteria') {
    if ((metrics.mae == null ? Infinity : metrics.mae) > req.mae_max) failures.push('mae>8');
    if ((metrics.e_agreement || 0) < req.e_agreement) failures.push('e_agreement<0.95');
  }
  return { pass: failures.length === 0, mode, required: req, failures };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

module.exports = {
  MIN_ELIGIBLE_N,
  m1, weightedKappa, capReliability, actionability, m4bPromote, m5, regressionGate,
};
