'use strict';
// G-Chain OS v2.0 構造化分析モジュール 単体テスト。node test/gchain-v2.test.js
const assert = require('assert');
const features = require('../src/gchain/features');
const outcome = require('../src/gchain/outcome');
const lossIntel = require('../src/gchain/loss-intel');
const reactivation = require('../src/gchain/reactivation');
const discipline = require('../src/gchain/discipline');

let pass = 0, fail = 0;
function t(msg, fn) {
  try { fn(); pass++; console.log('  ✓', msg); }
  catch (e) { fail++; process.exitCode = 1; console.error('  ✗', msg, '\n     ', e.message); }
}

// ---------------- features ----------------
console.log('features:');
t('icpBand: 51-150名=icp_core', () => {
  assert.strictEqual(features.icpBand('51～100名'), 'icp_core');
  assert.strictEqual(features.icpBand('3～5名'), 'micro');
  assert.strictEqual(features.icpBand('101～200名'), 'large');
});
t('callTimeFeatures: 曜日・時間帯', () => {
  const f = features.callTimeFeatures('2026-07-16 10:35');
  assert.strictEqual(f.call_band, 'am');
  assert.ok(['日', '月', '火', '水', '木', '金', '土'].includes(f.call_weekday));
});
t('extractFeatures: 架電時点特徴のみ・リーク無し', () => {
  const rec = {
    'カスタム情報：採用人数(選択リスト)': '51～100名',
    '会社情報：業種': 'IT',
    'コール結果1：開始日時': '2026-07-16 14:30',
    'リードソース：アウトバウンド': '○', 'リード流入日時：アウトバウンド': '2026-01-01',
  };
  const { features: f, leak } = features.extractFeatures(rec);
  assert.strictEqual(f.icp_band, 'icp_core');
  assert.strictEqual(f.source, 'アウトバウンド');
  assert.strictEqual(f.call_band, 'pm');
  assert.strictEqual(leak.length, 0);
});

// ---------------- outcome ----------------
console.log('outcome:');
t('extractLabels: アポ/商談/失注', () => {
  const l = outcome.extractLabels({ 'コール結果1：結果': '担当者接触：アポ獲得', '商談1：商談作成日時': '2026-07-01' });
  assert.strictEqual(l.appointment, true);
  assert.strictEqual(l.connected, true);
  assert.strictEqual(l.opportunity, true);
});
t('wilson: n増でCI縮む', () => {
  const w1 = outcome.wilson(1, 10), w2 = outcome.wilson(100, 1000);
  assert.ok((w2.high - w2.low) < (w1.high - w1.low));
});
t('liftByFeature: minN未満は除外・平滑化', () => {
  const recs = [];
  for (let i = 0; i < 100; i++) recs.push({ v: 'A', hit: i < 30 }); // 30% A
  for (let i = 0; i < 100; i++) recs.push({ v: 'B', hit: i < 5 });  // 5% B
  for (let i = 0; i < 10; i++) recs.push({ v: 'C', hit: true });    // n=10 <minN
  const rows = outcome.liftByFeature(recs, (r) => r.v, (r) => r.hit, { minN: 50 });
  assert.strictEqual(rows.length, 2); // C除外
  assert.strictEqual(rows[0].value, 'A'); // 高い順
  assert.ok(rows[0].lift > 1 && rows[1].lift < 1);
});
t('buildLiftModel + scoreLead: 高リフト特徴でスコア上昇', () => {
  const recs = [];
  for (let i = 0; i < 200; i++) recs.push({ f: { seg: 'good' }, hit: i < 60 }); // 30%
  for (let i = 0; i < 200; i++) recs.push({ f: { seg: 'bad' }, hit: i < 10 });  // 5%
  const model = outcome.buildLiftModel(recs, ['seg'], (r) => r.f, (r) => r.hit, { minN: 50 });
  const good = outcome.scoreLead({ seg: 'good' }, model);
  const bad = outcome.scoreLead({ seg: 'bad' }, model);
  assert.ok(good.score > model.base && bad.score < model.base, `good=${good.score} base=${model.base} bad=${bad.score}`);
});

// ---------------- loss-intel ----------------
console.log('loss-intel:');
t('classifyLoss: 時期相違=L_TIMING(actionable)', () => {
  assert.strictEqual(lossIntel.classifyLoss('検討時期相違').attribution, 'L_TIMING');
  assert.strictEqual(lossIntel.classifyLoss('検討時期相違').actionable, true);
  assert.strictEqual(lossIntel.classifyLoss('予算なし（来期以降も不可）').actionable, false);
});
t('summarizeLoss: 帰属集計・actionable比率', () => {
  const recs = [{ r: '検討時期相違' }, { r: '検討時期相違' }, { r: '予算なし（来期以降も不可）' }];
  const s = lossIntel.summarizeLoss(recs, (x) => x.r);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.actionable_share, 0.667); // round3(2/3)
});

// ---------------- reactivation ----------------
console.log('reactivation:');
t('reactivationPriority: 検討直近＋更新前で高スコア', () => {
  const p = reactivation.reactivationPriority(
    { consider_timing: '2026年8月', renewal_month: '2026年9月' }, { y: 2026, m: 7, today: '2026-07-16' });
  assert.ok(p.priority >= 45, 'priority=' + p.priority);
});
t('reactivationPriority: 失注1年超は減衰', () => {
  const p = reactivation.reactivationPriority({ loss_date: '2024-01-01' }, { y: 2026, m: 7, today: '2026-07-16' });
  assert.ok(p.priority === 0);
});
t('parseMonth: 各表記', () => {
  assert.deepStrictEqual(reactivation.parseMonth('2026年8月', 2026), { y: 2026, m: 8 });
  assert.deepStrictEqual(reactivation.parseMonth('9月', 2026), { y: 2026, m: 9 });
});

// ---------------- discipline ----------------
console.log('discipline:');
t('recordDiscipline: 予定/完了/overdue', () => {
  const rec = {
    '次のアクション1：アクション名': 'コール', '次のアクション1：予定日時': '2026-07-01 10:00', '次のアクション1：完了日時': '2026-07-03 10:00',
    '次のアクション2：アクション名': 'メール', '次のアクション2：予定日時': '2026-07-10 10:00', '次のアクション2：完了日時': '',
  };
  const d = discipline.recordDiscipline(rec, '2026-07-16');
  assert.strictEqual(d.planned, 2);
  assert.strictEqual(d.completed, 1);
  assert.strictEqual(d.overdue, 1); // action2 予定超過・未完了
  assert.strictEqual(d.avg_interval_days, 2);
});
t('disciplineByOwner: 所有者別ロールアップ', () => {
  const recs = [
    { 'リード関連情報：リード所有者': '田中', '次のアクション1：予定日時': '2026-07-01', '次のアクション1：完了日時': '2026-07-02' },
    { 'リード関連情報：リード所有者': '田中', '次のアクション1：予定日時': '2026-07-01', '次のアクション1：完了日時': '' },
  ];
  const out = discipline.disciplineByOwner(recs, '2026-07-16', (r) => r['リード関連情報：リード所有者']);
  assert.strictEqual(out[0].owner, '田中');
  assert.strictEqual(out[0].planned, 2);
  assert.strictEqual(out[0].follow_execution_rate, 0.5);
});

console.log(`\ngchain-v2: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
