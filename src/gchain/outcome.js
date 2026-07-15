'use strict';
/**
 * G-Chain OS v2.0 — 成果ラベル＋リフトスコアリング（設計書 §4.2, §5）。
 *
 * 構造化コール結果から成果ラベルを確定し、特徴×ラベルの解釈可能なリフト分析で
 * 「アポが出るセグメント」を定量化 → 未架電リード/将来リストをスコアリング。
 * ブラックボックスML不使用（原則6）。ラプラス平滑化＋Wilson区間でn過少を抑制。
 * 純関数（外部I/O無し）。
 */

const APPOINTMENT_RESULT = '担当者接触：アポ獲得';
const CONNECTED_RESULTS = new Set([
  '担当者接触：アポ獲得', '担当者接触：お断り', '担当者接触：営業フォロー',
  'ヒアリング成功', 'ヒアリング不可', '問い合わせ',
]);

/**
 * 成果ラベル抽出（設計書 §5.1）。架電後に確定する情報のみ。
 * 返り値: { connected, appointment, opportunity, lost, loss_reason_major, label_available_at }
 */
function extractLabels(rec) {
  const result = (rec['コール結果1：結果'] || '').trim();
  const dealCreated = (rec['商談1：商談作成日時'] || '').trim();
  const lossDate = (rec['カスタム情報：失注商談失注日'] || '').trim();
  const lossMajor = (rec['カスタム情報：失注商談失注理由大'] || '').trim();
  return {
    connected: CONNECTED_RESULTS.has(result),
    appointment: result === APPOINTMENT_RESULT,
    opportunity: !!dealCreated,
    lost: !!lossDate || !!lossMajor,
    loss_reason_major: lossMajor || null,
    label_available_at: (rec['コール結果1：開始日時'] || '').trim() || null,
  };
}

/** ベースレート（全体のラベル率）。 */
function baseRate(records, labelFn) {
  let n = 0, hits = 0;
  for (const r of records) { n++; if (labelFn(r)) hits++; }
  return { n, hits, rate: n ? hits / n : 0 };
}

/** Wilson score 区間（二項比率の信頼区間・z=1.96）。 */
function wilson(hits, n, z) {
  if (!n) return { low: 0, high: 0 };
  z = z || 1.96;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * 特徴値ごとのリフト（設計書 §4.2）。
 * records: レコード配列。featureFn(rec)→値, labelFn(rec)→bool。
 * opts: { minN=30, alpha=1, base }（alpha=ラプラス平滑化の擬似カウント）
 * 返り値: [{ value, n, hits, rate, smoothed_rate, lift, wilson_low, wilson_high }]（lift降順）
 */
function liftByFeature(records, featureFn, labelFn, opts) {
  const o = opts || {};
  const minN = o.minN != null ? o.minN : 30;
  const alpha = o.alpha != null ? o.alpha : 1;
  const base = o.base != null ? o.base : baseRate(records, labelFn).rate;

  const groups = new Map();
  for (const r of records) {
    const v = featureFn(r);
    if (v == null || v === '') continue;
    if (!groups.has(v)) groups.set(v, { n: 0, hits: 0 });
    const g = groups.get(v);
    g.n++; if (labelFn(r)) g.hits++;
  }
  const rows = [];
  for (const [value, g] of groups) {
    if (g.n < minN) continue;
    const smoothed = (g.hits + alpha * base) / (g.n + alpha);
    const w = wilson(g.hits, g.n);
    rows.push({
      value, n: g.n, hits: g.hits,
      rate: round4(g.n ? g.hits / g.n : 0),
      smoothed_rate: round4(smoothed),
      lift: base ? round3(smoothed / base) : null,
      wilson_low: round4(w.low), wilson_high: round4(w.high),
    });
  }
  rows.sort((a, b) => b.smoothed_rate - a.smoothed_rate);
  return rows;
}

/**
 * リフトモデル構築（設計書 §4.2）。特徴キー配列ごとに平滑化率テーブルを作る。
 * featureExtractor(rec)→{key:value}。返り値: { base, features:{key:{value:smoothed_rate}} }
 */
function buildLiftModel(records, featureKeys, featureExtractor, labelFn, opts) {
  const base = baseRate(records, labelFn).rate;
  const model = { base: round4(base), features: {}, meta: { n: records.length, minN: (opts && opts.minN) || 30 } };
  for (const key of featureKeys) {
    const rows = liftByFeature(records, (r) => featureExtractor(r)[key], labelFn, Object.assign({ base }, opts));
    const table = {};
    for (const row of rows) table[row.value] = row.smoothed_rate;
    model.features[key] = table;
  }
  return model;
}

/**
 * リード成果スコア（設計書 §4.2）。素朴ベイズ的な log-odds 合算（解釈可能）。
 * score = logit(base) + Σ(logit(rate_fv) - logit(base))。既知の特徴値のみ寄与。
 * 返り値: { score(0..1), logit, contributions:[{key,value,delta}] }
 */
function scoreLead(featureObj, model) {
  const base = model.base || 1e-6;
  let logit = logitOf(base);
  const contributions = [];
  for (const [key, table] of Object.entries(model.features)) {
    const v = featureObj[key];
    if (v == null || !(v in table)) continue;
    const delta = logitOf(table[v]) - logitOf(base);
    logit += delta;
    contributions.push({ key, value: v, rate: table[v], delta: round3(delta) });
  }
  contributions.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { score: round4(sigmoid(logit)), logit: round3(logit), contributions };
}

function logitOf(p) {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(q / (1 - q));
}
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function round3(n) { return n == null ? null : Math.round(n * 1000) / 1000; }
function round4(n) { return n == null ? null : Math.round(n * 10000) / 10000; }

module.exports = {
  APPOINTMENT_RESULT, CONNECTED_RESULTS,
  extractLabels, baseRate, wilson, liftByFeature, buildLiftModel, scoreLead,
};
