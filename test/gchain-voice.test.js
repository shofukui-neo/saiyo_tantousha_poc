'use strict';
// G-Chain OS v2.1 音声レイヤ 単体テスト。node test/gchain-voice.test.js
const assert = require('assert');
const metrics = require('../src/gchain/voice/metrics');
const feedback = require('../src/gchain/voice/feedback');
const weakness = require('../src/gchain/voice/weakness');
const analyze = require('../src/gchain/voice/analyze');
const { CALL_TALKATIVE, CALL_BALANCED, CALL_CUTOFF } = require('../src/gchain/voice/fixtures');

let pass = 0, fail = 0;
function t(msg, fn) { try { fn(); pass++; console.log('  ✓', msg); } catch (e) { fail++; process.exitCode = 1; console.error('  ✗', msg, '\n     ', e.message); } }

// ---------------- metrics ----------------
console.log('voice/metrics:');
t('話しすぎ通話: talk比高・質問0・打診なし', () => {
  const m = metrics.computeMetrics(CALL_TALKATIVE);
  assert.ok(m.talk_ratio_self > 0.85, 'talk_ratio=' + m.talk_ratio_self);
  assert.strictEqual(m.question_count, 0);
  assert.strictEqual(m.proposal_made, false); // 「ご案内」を打診に誤検知しない
  assert.ok(m.longest_monologue_sec >= 40);
});
t('良い通話: 質問複数・打診あり・バランス', () => {
  const m = metrics.computeMetrics(CALL_BALANCED);
  assert.ok(m.question_count >= 3, 'q=' + m.question_count);
  assert.strictEqual(m.proposal_made, true); // 来週/画面を見て
  assert.ok(m.talk_ratio_self >= 0.4 && m.talk_ratio_self <= 0.65);
});
t('冒頭切れ通話: 打診なし・相手が反論', () => {
  const m = metrics.computeMetrics(CALL_CUTOFF);
  assert.strictEqual(m.proposal_made, false);
  assert.ok(m.objection_count >= 1); // 「今は結構です。忙しい」
});
t('話者切替でターン数, 独白は連続self合計', () => {
  const segs = [
    { speaker: 'self', start: 0, end: 10, text: 'あ' },
    { speaker: 'self', start: 10, end: 25, text: 'い' },
    { speaker: 'customer', start: 25, end: 27, text: 'う' },
    { speaker: 'self', start: 27, end: 32, text: 'え' },
  ];
  const m = metrics.computeMetrics(segs);
  assert.strictEqual(m.longest_monologue_sec, 25); // 0-25 連続self
  assert.strictEqual(m.turn_count, 3);
});

// ---------------- feedback ----------------
console.log('voice/feedback:');
t('良い通話は高スコア・話しすぎ通話は低スコア', () => {
  const good = feedback.buildFeedback(metrics.computeMetrics(CALL_BALANCED), { connected: true });
  const bad = feedback.buildFeedback(metrics.computeMetrics(CALL_TALKATIVE), { connected: true });
  assert.ok(good.execution_score > bad.execution_score);
  assert.ok(good.execution_score >= 80 && bad.execution_score <= 40);
});
t('MORE は最弱次元・具体的next_action付き', () => {
  const f = feedback.buildFeedback(metrics.computeMetrics(CALL_TALKATIVE), { connected: true });
  assert.ok(f.more && f.more.point);
  assert.ok(f.more.next_action && f.more.next_action.length > 5);
  assert.ok(f.next_ng && f.next_ng.stop_condition);
});
t('dims は5次元・0-1', () => {
  const f = feedback.buildFeedback(metrics.computeMetrics(CALL_BALANCED), {});
  for (const k of ['balance', 'questions', 'proposal', 'opening', 'monologue']) {
    assert.ok(f.dims[k] >= 0 && f.dims[k] <= 1, k + '=' + f.dims[k]);
  }
});

// ---------------- analyze orchestrator ----------------
console.log('voice/analyze:');
t('analyzeCall: レコードに metrics/feedback/connected', () => {
  const r = analyze.analyzeCall({ company: 'X', started_at: '2026-07-24T09:00:00Z', segments: CALL_BALANCED, useLLM: false });
  assert.ok(r.metrics && r.feedback);
  assert.strictEqual(r.connected, true);
  assert.strictEqual(r.company, 'X');
});
t('toTranscriptText: 自分/相手ラベル', () => {
  const txt = analyze.toTranscriptText(CALL_CUTOFF);
  assert.ok(/自分:/.test(txt) && /相手:/.test(txt));
});

// ---------------- weakness ----------------
console.log('voice/weakness:');
function rec(seg, at) { return analyze.analyzeCall({ started_at: at, segments: seg, useLLM: false }); }
t('弱みを特定・強みを分離', () => {
  const recs = [rec(CALL_TALKATIVE, '2026-07-24T09:00:00Z'), rec(CALL_CUTOFF, '2026-07-24T10:00:00Z'), rec(CALL_BALANCED, '2026-07-24T11:00:00Z')];
  const w = weakness.aggregateWeakness(recs);
  assert.strictEqual(w.n, 3);
  const weakKeys = w.weaknesses.map((x) => x.key);
  assert.ok(weakKeys.includes('questions'), 'ヒアリングが弱みに出る');
  assert.ok(w.metrics.proposal_rate <= 0.4); // 3件中1件のみ打診
});
t('トレンド: 悪い→良いで正の傾き', () => {
  const recs = [rec(CALL_TALKATIVE, '2026-07-24T09:00:00Z'), rec(CALL_BALANCED, '2026-07-24T11:00:00Z')];
  const w = weakness.aggregateWeakness(recs);
  assert.ok(w.score_trend > 0, 'trend=' + w.score_trend);
});
t('空履歴でも落ちない', () => {
  const w = weakness.aggregateWeakness([]);
  assert.strictEqual(w.n, 0);
});

console.log(`\ngchain-voice: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
