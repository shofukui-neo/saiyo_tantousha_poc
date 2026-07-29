'use strict';
// G-Chain OS 評価・KPI・実験ロジック単体テスト。node test/gchain-eval.test.js
const assert = require('assert');
const scoring = require('../src/gchain/scoring');
const kpi = require('../src/gchain/kpi');
const exp = require('../src/gchain/experiment');

let pass = 0, fail = 0;
function t(msg, fn) {
  try { fn(); pass++; console.log('  ✓', msg); }
  catch (e) { fail++; process.exitCode = 1; console.error('  ✗', msg, '\n     ', e.message); }
}

// ---------------- scoring ----------------
console.log('scoring:');
function items(specs) {
  // specs: [[id, section, score]]
  return specs.map(([id, section, score]) => ({ id, section, score }));
}
t('NAは0点扱いせず分母から除外', () => {
  const r = scoring.computeQ(items([
    ['q1', 'A', 2], ['q2', 'A', 2], ['q3', 'B', 'NA'],
    ['q4', 'B', 2], ['q5', 'C', 2], ['q6', 'C', 2],
    ['q7', 'D', 2], ['q8', 'D', 2],
  ]));
  // 適用8項目 → NA除外で実際は7項目(q3除く)... 上は8のうちq3がNA → 7適用
  assert.strictEqual(r.applicable_max, 14); // 7*2 <16 → INSUFFICIENT
  assert.strictEqual(r.status, 'Q_INSUFFICIENT');
});
t('適用可能満点<16 → Q_INSUFFICIENT', () => {
  const r = scoring.computeQ(items([['q1', 'A', 2], ['q2', 'A', 2]]));
  assert.strictEqual(r.status, 'Q_INSUFFICIENT');
  assert.strictEqual(r.q_raw, null);
});
t('Q_raw = 100*得点/適用可能満点', () => {
  const specs = [];
  for (let i = 0; i < 10; i++) specs.push(['q' + i, 'A', i < 5 ? 2 : 1]);
  const r = scoring.computeQ(items(specs)); // 10項目, 得点=5*2+5*1=15, max=20
  assert.strictEqual(r.status, 'OK');
  assert.strictEqual(r.q_raw, 75);
});
t('セクション別サブスコア', () => {
  const specs = [];
  for (let i = 0; i < 8; i++) specs.push(['a' + i, 'A', 2]);
  for (let i = 0; i < 8; i++) specs.push(['b' + i, 'B', 1]);
  const r = scoring.computeQ(items(specs));
  assert.strictEqual(r.subscores.A, 100);
  assert.strictEqual(r.subscores.B, 50);
  assert.strictEqual(r.subscores.C, null);
});
t('C0: Q上限49・教師除外, cap前後保存', () => {
  const specs = [];
  for (let i = 0; i < 10; i++) specs.push(['q' + i, 'A', 2]); // q_raw=100
  const q = scoring.computeQ(items(specs));
  const capped = scoring.applyCaps(q, ['C0'], 3);
  assert.strictEqual(capped.q_pre_cap, 100);
  assert.strictEqual(capped.q_post_cap, 49);
  assert.strictEqual(capped.teacher_excluded, true);
});
t('C2: A=0強制, C3: PP除外・ITT残す', () => {
  const specs = [];
  for (let i = 0; i < 10; i++) specs.push(['q' + i, 'A', 2]);
  const q = scoring.computeQ(items(specs));
  const capped = scoring.applyCaps(q, ['C2', 'C3'], 3);
  assert.strictEqual(capped.a_post_cap, 0);
  assert.strictEqual(capped.pp_excluded, true);
  assert.strictEqual(capped.itt_retained, true);
});
t('共通項目法: 両期間で適用された項目のみ', () => {
  const A = items([['q1', 'A', 2], ['q2', 'A', 2], ['q3', 'A', 'NA']]);
  const B = items([['q1', 'A', 1], ['q2', 'A', 'NA'], ['q3', 'A', 2]]);
  const r = scoring.commonItemMethod(A, B);
  assert.deepStrictEqual(r.shared_ids, ['q1']); // q1のみ両方適用
});
t('mastered は優先度除外のみ・総合に残る', () => {
  const its = [{ id: 'q1', section: 'A', score: 2, mastered: true }, { id: 'q2', section: 'A', score: 2 }];
  assert.strictEqual(scoring.priorityItems(its).length, 1);
  const r = scoring.computeQ(its);
  assert.strictEqual(r.applicable_max, 4); // masteredも総合分母に残る
});
t('morePriority = 4因子積', () => {
  assert.strictEqual(scoring.morePriority({ frequency: 2, gate_loss: 3, controllability: 1, confidence: 0.5 }), 3);
});

// ---------------- kpi ----------------
console.log('kpi:');
function call(over) {
  return Object.assign({
    e0_state: 'TRUE', e1_state: 'TRUE', e2_state: 'TRUE',
    e3_state: 'TRUE', e4_state: 'TRUE', e5_state: 'FALSE', e6_state: 'NOT_ELIGIBLE',
    e7_state: 'FALSE', e8_state: 'NOT_ELIGIBLE',
    official_metric_eligible: true, purpose_planned: 'NEW_PROSPECTING',
  }, over);
}
t('UNKNOWN/NOT_ELIGIBLE は分母外', () => {
  const calls = [
    call({ e4_state: 'TRUE' }), call({ e4_state: 'FALSE' }),
    call({ e4_state: 'UNKNOWN' }), call({ e4_state: 'NOT_ELIGIBLE' }),
  ];
  const r = kpi.runKpi('e4_rate', calls);
  assert.strictEqual(r.denominator, 2); // TRUE,FALSE のみ
  assert.strictEqual(r.numerator, 1);
});
t('会話系は official_metric_eligible 必須', () => {
  const calls = [call({ e4_state: 'TRUE' }), call({ e4_state: 'TRUE', official_metric_eligible: false })];
  const r = kpi.runKpi('e4_rate', calls);
  assert.strictEqual(r.denominator, 1); // official のみ
});
t('E2率は全通話（official不要）', () => {
  const calls = [call({ e2_state: 'TRUE', official_metric_eligible: false }), call({ e2_state: 'FALSE' })];
  const r = kpi.runKpi('e2_rate', calls);
  assert.strictEqual(r.denominator, 2);
  assert.strictEqual(r.value, 0.5);
});
t('打診率は E5∧opportunity=yes 分母', () => {
  const calls = [
    call({ e5_state: 'TRUE', proposal_opportunity: 'yes', e6_state: 'TRUE' }),
    call({ e5_state: 'TRUE', proposal_opportunity: 'no', e6_state: 'FALSE' }),
    call({ e5_state: 'TRUE', proposal_opportunity: 'yes', e6_state: 'FALSE' }),
  ];
  const r = kpi.runKpi('proposal_rate', calls);
  assert.strictEqual(r.denominator, 2); // opportunity=yes のみ
  assert.strictEqual(r.numerator, 1);
});
t('purposeセグメントで絞れる', () => {
  const calls = [call({ e4_state: 'TRUE' }), call({ e4_state: 'TRUE', purpose_planned: 'REACTIVATION' })];
  const r = kpi.runKpi('e4_rate', calls, { purpose: 'NEW_PROSPECTING' });
  assert.strictEqual(r.denominator, 1);
});
t('heldRate: pending窓内(UNKNOWN)は分母外', () => {
  const r = kpi.heldRate([
    { next_step_disposition: 'created', next_step_outcome: 'held', e8_resolved: 'TRUE' },
    { next_step_disposition: 'created', next_step_outcome: 'pending', e8_resolved: 'UNKNOWN' },
    { next_step_disposition: 'created', next_step_outcome: 'no_show', e8_resolved: 'FALSE' },
  ]);
  assert.strictEqual(r.denominator, 2); // UNKNOWN除外
  assert.strictEqual(r.numerator, 1);
});
t('funnel: 状態分布（UNKNOWN帯可視化）', () => {
  const calls = [call({ e4_state: 'TRUE' }), call({ e4_state: 'UNKNOWN' })];
  const f = kpi.funnel(calls, ['E4']);
  assert.strictEqual(f.E4.TRUE, 1);
  assert.strictEqual(f.E4.UNKNOWN, 1);
});

// ---------------- experiment ----------------
console.log('experiment:');
t('assignArm は決定的・実験間独立', () => {
  const a1 = exp.assignArm('uid1', 'exp001');
  assert.strictEqual(a1, exp.assignArm('uid1', 'exp001'));
  assert.ok(exp.ARMS.includes(a1));
});
t('割付は概ね二分（分布チェック）', () => {
  let a = 0, b = 0;
  for (let i = 0; i < 400; i++) (exp.assignArm('u' + i, 'e') === 'A' ? a++ : b++);
  assert.ok(a > 120 && b > 120, `偏り: A=${a} B=${b}`);
});
t('isMasked: 判定日前はマスク', () => {
  assert.strictEqual(exp.isMasked('2026-07-16', '2026-07-20'), true);
  assert.strictEqual(exp.isMasked('2026-07-21', '2026-07-20'), false);
});
t('checkFidelity: B腕はgive必須, A腕はgive混入で汚染', () => {
  assert.strictEqual(exp.checkFidelity({ give_first_detected: true }, 'B').compliant, true);
  assert.strictEqual(exp.checkFidelity({ give_first_detected: false }, 'B').compliant, false);
  assert.strictEqual(exp.checkFidelity({ give_first_detected: true }, 'A').compliant, false);
});
t('decideExperiment: マスク中はmasked, 判定後はITT/PP', () => {
  const metric = { inDenom: (c) => ['TRUE', 'FALSE'].includes(c.e4_state), numerator: (c) => c.e4_state === 'TRUE' };
  const calls = [
    { assigned_arm: 'A', e4_state: 'TRUE', give_first_detected: false },
    { assigned_arm: 'A', e4_state: 'FALSE', give_first_detected: false },
    { assigned_arm: 'B', e4_state: 'TRUE', give_first_detected: true },
    { assigned_arm: 'B', e4_state: 'TRUE', give_first_detected: true },
  ];
  const masked = exp.decideExperiment(calls, metric, { decision_date: '2026-07-30' }, '2026-07-16');
  assert.strictEqual(masked.masked, true);
  const decided = exp.decideExperiment(calls, metric, { decision_date: '2026-07-15' }, '2026-07-16');
  assert.strictEqual(decided.masked, false);
  assert.strictEqual(decided.itt.A.value, 0.5);
  assert.strictEqual(decided.itt.B.value, 1);
  assert.strictEqual(decided.itt.diff, 0.5);
});

console.log(`\ngchain-eval: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
