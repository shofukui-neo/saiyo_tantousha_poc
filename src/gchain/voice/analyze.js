'use strict';
/**
 * G-Chain OS v2.1 — 通話分析オーケストレータ。
 * segments → 客観指標 → ルールベースFB →（任意でLLM診断で補強）→ 通話レコード。
 * 純ロジック（保存は呼出側 store.saveCall）。
 */
const metricsMod = require('./metrics');
const feedbackMod = require('./feedback');
const llm = require('./llm');

/** segments を "自分: ...\n相手: ..." のテキストへ。 */
function toTranscriptText(segments) {
  return segments.map((s) => `${s.speaker === 'self' ? '自分' : '相手'}: ${s.text}`).join('\n');
}

/** 接続(E2)成立の目安: 相手が実質的に話している。 */
function inferConnected(metrics) {
  return (metrics.customer_talk_sec || 0) >= 5 && (metrics.seg_count || 0) >= 3;
}

/**
 * 分析実行。
 * input: { segments, company?, started_at?, audio_path?, transcript_path?, operator?, useLLM? }
 * 返り値: 通話レコード（store.saveCall にそのまま渡せる）。
 */
function analyzeCall(input) {
  const segments = input.segments || [];
  const metrics = metricsMod.computeMetrics(segments);
  const connected = inferConnected(metrics);
  const feedback = feedbackMod.buildFeedback(metrics, { connected });

  const record = {
    call_id: input.call_id || null,
    started_at: input.started_at || null,
    company: input.company || null,
    operator: input.operator || 'self',
    audio_path: input.audio_path || null,
    transcript_path: input.transcript_path || null,
    connected,
    segments,
    metrics,
    feedback,
    llm: null,
  };

  // 任意: LLM で LCS 診断を補強
  const wantLLM = input.useLLM !== false && llm.available();
  if (wantLLM) {
    const diag = llm.diagnose(toTranscriptText(segments));
    if (diag) {
      record.llm = diag;
      // LLM の good/more があればユーザー向け主表示に採用（指標FBはdimsとして残す）
      if (diag.good && diag.good.point) record.feedback.good = { point: diag.good.point, quote: diag.good.quote || null, source: 'llm' };
      if (diag.more && diag.more.point) record.feedback.more = { point: diag.more.point, next_action: diag.more.next_action || null, source: 'llm' };
      if (diag.next_ng && diag.next_ng.stop_condition) record.feedback.next_ng = { stop_condition: diag.next_ng.stop_condition, source: 'llm' };
      record.events = diag.events || [];
    }
  }
  return record;
}

module.exports = { analyzeCall, toTranscriptText, inferConnected };
