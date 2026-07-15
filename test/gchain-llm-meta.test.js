'use strict';
// G-Chain OS LLM契約・M層メタ評価 単体テスト。node test/gchain-llm-meta.test.js
const assert = require('assert');
const llm = require('../src/gchain/llm-contract');
const meta = require('../src/gchain/meta');

let pass = 0, fail = 0;
function t(msg, fn) {
  try { fn(); pass++; console.log('  ✓', msg); }
  catch (e) { fail++; process.exitCode = 1; console.error('  ✗', msg, '\n     ', e.message); }
}

// ---------------- llm-contract ----------------
console.log('llm-contract:');
t('buildBlindPaste が結果・所感行を除去', () => {
  const tr = '担当: こんにちは\n結果: アポ取得\n所感: 良かった\n顧客: 今忙しい';
  const r = llm.buildBlindPaste(tr);
  assert.ok(!/アポ取得/.test(r.text));
  assert.ok(!/所感/.test(r.text));
  assert.ok(/今忙しい/.test(r.text));
  assert.strictEqual(r.stripped.length, 2);
});
t('detectBlindLeak が残存結果行を検出', () => {
  assert.strictEqual(llm.detectBlindLeak('顧客: そうですね\n失注でした').length, 1);
  assert.strictEqual(llm.detectBlindLeak('顧客: そうですね').length, 0);
});
t('validateL1Json: E4に引用無し→無効化', () => {
  const r = llm.validateL1Json({
    call_id: 'c1',
    events: [{ event_code: 'E4', event_order: 1, subtype: { info_class: 'timing' }, novelty: 'new', speaker: 'customer' }],
  });
  assert.strictEqual(r.valid, false);
  assert.ok(r.invalidated.length === 1);
});
t('validateL1Json: 低確信度→HOLD', () => {
  const r = llm.validateL1Json({
    call_id: 'c1',
    events: [{ event_code: 'E4', event_order: 1, subtype: { info_class: 'timing' }, novelty: 'new', speaker: 'customer', evidence_quote: 'x', label_confidence: 0.4 }],
  });
  assert.strictEqual(r.holds.length, 1);
  assert.strictEqual(r.valid, true);
});
t('validateL1Json: enum逸脱を検出', () => {
  const r = llm.validateL1Json({
    call_id: 'c1',
    events: [{ event_code: 'E4', event_order: 1, subtype: { info_class: 'nonsense' }, novelty: 'new', speaker: 'customer', evidence_quote: 'x' }],
  });
  assert.ok(r.errors.some((e) => e.startsWith('bad_info_class')));
});
t('validateL1Json: 正常なE5(b)は valid', () => {
  const r = llm.validateL1Json({
    call_id: 'c1',
    events: [{ event_code: 'E5', event_order: 2, subtype: { value_type: 'problem', disclosure_grade: 'b' }, speaker: 'customer', evidence_quote: '採用に困ってる', label_confidence: 0.8 }],
  });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.holds.length, 0);
});
t('validateL2Json: 引用空→無効', () => {
  const r = llm.validateL2Json({ call_id: 'c1', evidence_quotes: [], gate: { primary: 'G3', alternative_nonpsychological_cause: 'none' } });
  assert.ok(r.errors.includes('missing_evidence_quotes'));
});
t('validateL2Json: gate_confidence<0.60→HOLD', () => {
  const r = llm.validateL2Json({
    call_id: 'c1', evidence_quotes: ['q'],
    gate: { primary: 'G3', gate_confidence: 0.5, alternative_nonpsychological_cause: 'none' },
    attribution: { l_subclass: 'L-actionable' },
    good: { action: 'a', quote: 'q', passed_event: 'E4', reason: 'r', reuse_condition: 'c' },
    next_action: { when: 'w', do: 'd', say: 's', success: 'ok', window: '3d' },
    next_ng: { stop_condition: 'x', alternative: 'y' },
  });
  assert.strictEqual(r.status, 'HOLD');
  assert.strictEqual(r.valid, true);
});
t('validateL2Json: 未来情報リークを検出', () => {
  const r = llm.validateL2Json({ call_id: 'c1', evidence_quotes: ['q'], outcome: 'won', gate: { primary: 'G3', alternative_nonpsychological_cause: 'none' } });
  assert.ok(r.errors.some((e) => e.startsWith('future_info_leak')));
});
t('validateL2Json: GOOD/次行動/次NG 必須フィールド欠落を検出', () => {
  const r = llm.validateL2Json({
    call_id: 'c1', evidence_quotes: ['q'],
    gate: { primary: 'G3', gate_confidence: 0.8, alternative_nonpsychological_cause: 'none' },
    attribution: { l_subclass: 'L-actionable' },
    good: { action: 'a' }, // 欠落多数
  });
  assert.ok(r.errors.some((e) => e.startsWith('missing_good.')));
  assert.ok(r.errors.includes('missing_next_action'));
});

// ---------------- meta ----------------
console.log('meta:');
t('m1: 全満点→mastered（回帰番兵）', () => {
  assert.strictEqual(meta.m1([2, 2, 2, 2]).verdict, 'mastered');
});
t('m1: 全0→top_priority（休眠禁止）', () => {
  assert.strictEqual(meta.m1([0, 0, 0]).verdict, 'top_priority');
});
t('m1: 空→definition_suspect', () => {
  assert.strictEqual(meta.m1([]).verdict, 'definition_suspect');
});
t('m1: 目標乖離・週次変化', () => {
  const r = meta.m1([1, 1, 2], { target: 2, prev_mean: 1 });
  assert.strictEqual(r.eligible_n, 3);
  assert.ok(Math.abs(r.target_gap - (2 - r.mean)) < 1e-9);
  assert.ok(r.weekly_change != null);
});
t('weightedKappa: 完全一致=1', () => {
  assert.strictEqual(meta.weightedKappa([0, 1, 2, 2], [0, 1, 2, 2]), 1);
});
t('weightedKappa: 完全不一致は低κ', () => {
  const k = meta.weightedKappa([0, 0, 2, 2], [2, 2, 0, 0]);
  assert.ok(k < 0, `k=${k}`);
});
t('capReliability: 再現率100%・FP≤5%で pass', () => {
  const cases = [];
  for (let i = 0; i < 20; i++) cases.push({ gold_violation: true, detected_violation: true });
  for (let i = 0; i < 80; i++) cases.push({ gold_violation: false, detected_violation: false });
  assert.strictEqual(meta.capReliability(cases).pass, true);
});
t('capReliability: 見逃し1件で fail（生涯基準）', () => {
  const cases = [{ gold_violation: true, detected_violation: false }];
  assert.strictEqual(meta.capReliability(cases).pass, false);
});
t('actionability: MORE→実行可能率', () => {
  const r = meta.actionability([
    { more_selected: true, actionable_next_action: true },
    { more_selected: true, actionable_next_action: false },
    { more_selected: false },
  ]);
  assert.strictEqual(r, 0.5);
});
t('m4bPromote: 三条件充足で昇格', () => {
  assert.strictEqual(meta.m4bPromote({ proximal_effect: 6, min_practical_effect: 5, downstream: [1, 1], confounded: false }), true);
  assert.strictEqual(meta.m4bPromote({ proximal_effect: 6, min_practical_effect: 5, downstream: [1, -1], confounded: false }), false);
  assert.strictEqual(meta.m4bPromote({ proximal_effect: 6, min_practical_effect: 5, downstream: [1, 1], confounded: true }), false);
});
t('regressionGate: prompt_minor はゴールド20・item≥90%', () => {
  const pass = meta.regressionGate('prompt_minor', { gold_n: 20, item_agreement: 0.92, more_agreement: 0.85, c_detection_diff: 0 });
  assert.strictEqual(pass.pass, true);
  const fail = meta.regressionGate('prompt_minor', { gold_n: 20, item_agreement: 0.88, more_agreement: 0.85, c_detection_diff: 0 });
  assert.strictEqual(fail.pass, false);
});
t('regressionGate: model_or_criteria はゴールド60・MAE≤8・E一致≥95%', () => {
  const pass = meta.regressionGate('model_or_criteria', { gold_n: 60, item_agreement: 0.96, more_agreement: 0.85, c_detection_diff: 0, mae: 6, e_agreement: 0.96 });
  assert.strictEqual(pass.pass, true);
  const fail = meta.regressionGate('model_or_criteria', { gold_n: 60, item_agreement: 0.96, more_agreement: 0.85, c_detection_diff: 0, mae: 10, e_agreement: 0.96 });
  assert.ok(fail.failures.includes('mae>8'));
});

console.log(`\ngchain-llm-meta: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
