'use strict';
/**
 * G-Chain OS v2.1 — 弱み蓄積分析（純関数）。
 * 通話履歴を集計し「自分の弱み・強み・改善トレンド」をデータで可視化する。
 * これが本システムの3本目の柱＝蓄積で自分の出来ていない部分を判断する層。
 */
const { DIMS } = require('./feedback');

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * 履歴集計。
 * records: [{ started_at, metrics, feedback:{ execution_score, dims } }]
 * opts: { recentN }（直近N件に絞る）
 */
function aggregateWeakness(records, opts) {
  const o = opts || {};
  const sorted = [...records].filter((r) => r && r.feedback)
    .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
  const recent = o.recentN ? sorted.slice(-o.recentN) : sorted;
  const n = recent.length;
  if (!n) return { n: 0, weaknesses: [], strengths: [], dims: [], metrics: {}, avg_score: null };

  // 次元別集計
  const dimAgg = DIMS.map((d) => {
    const vals = recent.map((r) => r.feedback.dims && r.feedback.dims[d.key]).filter((v) => v != null);
    const a = avg(vals);
    const weakCount = vals.filter((v) => v < 0.5).length;
    return {
      key: d.key, label: d.label, weight: d.weight,
      avg: round2(a), weak_count: weakCount, sample: vals.length,
      weak_rate: vals.length ? round2(weakCount / vals.length) : null,
    };
  });

  // 指標別集計
  const M = recent.map((r) => r.metrics || {});
  const metrics = {
    avg_execution_score: round1(avg(recent.map((r) => r.feedback.execution_score).filter((x) => x != null))),
    avg_talk_ratio_self: round2(avg(M.map((m) => m.talk_ratio_self).filter((x) => x != null))),
    avg_question_count: round1(avg(M.map((m) => m.question_count).filter((x) => x != null))),
    proposal_rate: round2(avg(M.map((m) => (m.proposal_made ? 1 : 0)))),
    avg_opening_first_sec: round1(avg(M.map((m) => m.opening_first_sec ?? m.opening_customer_first_sec).filter((x) => x != null))),
    avg_longest_monologue_sec: round1(avg(M.map((m) => m.longest_monologue_sec).filter((x) => x != null))),
  };

  // トレンド（前半 vs 後半の平均execution_score）
  const half = Math.floor(n / 2);
  const older = recent.slice(0, half).map((r) => r.feedback.execution_score).filter((x) => x != null);
  const newer = recent.slice(half).map((r) => r.feedback.execution_score).filter((x) => x != null);
  const score_trend = (older.length && newer.length) ? round1(avg(newer) - avg(older)) : null;

  // 弱み＝平均が低い次元（<0.6）。頻度文つき。
  const weaknesses = dimAgg.filter((d) => d.avg != null && d.avg < 0.6)
    .sort((a, b) => a.avg - b.avg)
    .map((d) => ({
      ...d,
      message: `${d.label}：直近${d.sample}件中${d.weak_count}件で不足（平均${Math.round(d.avg * 100)}点）`,
    }));
  const strengths = dimAgg.filter((d) => d.avg != null && d.avg >= 0.7)
    .sort((a, b) => b.avg - a.avg)
    .map((d) => ({ ...d, message: `${d.label}：安定（平均${Math.round(d.avg * 100)}点）` }));

  return { n, avg_score: metrics.avg_execution_score, score_trend, dims: dimAgg, metrics, weaknesses, strengths };
}

module.exports = { aggregateWeakness };
