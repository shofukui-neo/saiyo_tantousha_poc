'use strict';
// G-Chain OS コアロジック単体テスト（外部I/O無し）。node test/gchain-core.test.js
const assert = require('assert');

const schema = require('../src/gchain/schema');
const norm = require('../src/gchain/normalize');
const canon = require('../src/gchain/canonical');
const engine = require('../src/gchain/event-engine');
const sampling = require('../src/gchain/sampling');

let pass = 0, fail = 0;
function t(msg, fn) {
  try { fn(); pass++; console.log('  ✓', msg); }
  catch (e) { fail++; process.exitCode = 1; console.error('  ✗', msg, '\n     ', e.message); }
}

// ---------------- schema ----------------
console.log('schema:');
t('永続HUBは19シート（揮発staging除く）', () => {
  assert.strictEqual(schema.persistentSheetKeys().length, 19);
});
t('生成ビューは 01/07/12/14/17', () => {
  const gen = Object.keys(schema.SHEETS).filter((k) => schema.isGenerated(k)).sort();
  assert.deepStrictEqual(gen, ['01_架電イベント', '07_集計', '12_データ品質', '14_教師データVIEW', '17_ジャーニー'].sort());
});
t('physicalColumns が監査共通列を末尾に付与', () => {
  const cols = schema.physicalColumns('18_Eイベント明細');
  assert.deepStrictEqual(cols.slice(-4), schema.AUDIT_COLUMNS.slice());
  assert.ok(cols.includes('is_canonical'));
});
t('E7強度: meeting_confirmed=4, unilateral_callback=0', () => {
  assert.strictEqual(schema.E7_STRENGTH.meeting_confirmed, 4);
  assert.strictEqual(schema.E7_STRENGTH.unilateral_callback, 0);
});

// ---------------- normalize ----------------
console.log('normalize:');
t('normPhone: +81ハイフン → 先頭0', () => {
  assert.strictEqual(norm.normPhone('+81-3-1234-5678'), '0312345678');
  assert.strictEqual(norm.normPhone('81312345678'), '0312345678');
  assert.strictEqual(norm.normPhone('03(1234)5678'), '0312345678');
});
t('normDatetime: 和暦セパレータ・ゼロ埋め', () => {
  assert.strictEqual(norm.normDatetime('2026/7/5 9:3'), '2026-07-05 09:03:00');
  assert.strictEqual(norm.normDatetime('2026年7月5日 14時30分'), '2026-07-05 14:30:00');
});
t('normDate: 先頭10文字', () => {
  assert.strictEqual(norm.normDate('2026/7/5 9:3'), '2026-07-05');
});
t('stableHashHex は決定的・16桁', () => {
  const a = norm.stableHashHex('abc'); const b = norm.stableHashHex('abc');
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 16);
  assert.notStrictEqual(norm.stableHashHex('abc'), norm.stableHashHex('abd'));
});
t('rowHash は正規化後に等価な入力で一致（再貼付増分0の根拠）', () => {
  const h1 = norm.rowHash({ datetime: '2026/7/5 9:3', phone: '+81-3-1234-5678', call_sec: 42, result: 'アポ' });
  const h2 = norm.rowHash({ datetime: '2026-07-05 09:03:00', phone: '0312345678', call_sec: '42', result: ' アポ ' });
  assert.strictEqual(h1, h2);
});
t('idempotencyKey: source_event_id 優先', () => {
  assert.strictEqual(
    norm.idempotencyKey({ source_system: 'BALES', source_event_id: 'X1' }), 'BALES:X1');
  assert.ok(norm.idempotencyKey({ datetime: 'a', phone: 'b' }).startsWith('hash:'));
});
t('matchKey: 法人番号 > 電話 > 社名', () => {
  assert.strictEqual(norm.matchKey({ corporate_number: '1234567890123' }).basis, 'corporate_number');
  assert.strictEqual(norm.matchKey({ phone: '03-1234-5678' }).basis, 'phone');
  assert.strictEqual(norm.matchKey({ company_name: '株式会社テスト' }).basis, 'company_name');
  assert.strictEqual(norm.matchKey({}).key, null);
});

// ---------------- canonical ----------------
console.log('canonical:');
t('dedupKey: call+event+subtype+bucket', () => {
  const k = canon.dedupKey({ call_id: 'c1', event_code: 'E4', subtype: 'Timing', occurred_at_sec: 65 }, { bucketSec: 30 });
  assert.strictEqual(k, 'c1#E4#timing#2');
});
t('pickCanonical: source優先度（E7は sf > transcript）', () => {
  const group = [
    { observation_id: 'o1', source_type: 'miitel_transcript', event_code: 'E7' },
    { observation_id: 'o2', source_type: 'sf', event_code: 'E7' },
  ];
  assert.strictEqual(canon.pickCanonical(group, 'E7').observation_id, 'o2');
});
t('pickCanonical: manual は常に最優先', () => {
  const group = [
    { observation_id: 'o1', source_type: 'sf', event_code: 'E7' },
    { observation_id: 'o2', source_type: 'manual', event_code: 'E7' },
  ];
  assert.strictEqual(canon.pickCanonical(group, 'E7').observation_id, 'o2');
});
t('dedupeObservations: 複数源→1正規（AT-0 canonical統合）', () => {
  const obs = [
    { observation_id: 'o1', event_id: 'e1', call_id: 'c1', event_code: 'E4', subtype: 'timing', occurred_at_sec: 60, source_type: 'bales_note' },
    { observation_id: 'o2', event_id: 'e2', call_id: 'c1', event_code: 'E4', subtype: 'timing', occurred_at_sec: 62, source_type: 'miitel_transcript' },
  ];
  const out = canon.dedupeObservations(obs, { bucketSec: 30 });
  const canonRows = out.filter((r) => r.is_canonical);
  assert.strictEqual(canonRows.length, 1);
  assert.strictEqual(canonRows[0].source_type, 'miitel_transcript');
  assert.strictEqual(out.every((r) => r.canonical_event_id === 'e2'), true);
});
t('assertCanonicalUnique が二重canonicalを検出', () => {
  const rows = [
    { dedup_key: 'k1', is_canonical: true },
    { dedup_key: 'k1', is_canonical: true },
  ];
  assert.strictEqual(canon.assertCanonicalUnique(rows).length, 1);
});
t('validateManualCorrection: 必須欠落を返す', () => {
  assert.deepStrictEqual(canon.validateManualCorrection({ editor: 'x', timestamp: 't' }).sort(), ['after', 'before']);
});

// ---------------- event-engine ----------------
console.log('event-engine:');
function baseCall(over) {
  return Object.assign({
    call_id: 'c1', event_observability: 'FULL',
    canonicalEvents: [], createdE7Records: [],
    flags: {}, nowSec: 1000000, e8WindowDays: 30,
  }, over);
}
t('E3 は E2=TRUE でないと NOT_ELIGIBLE', () => {
  const r = engine.resolveCall(baseCall({
    canonicalEvents: [{ event_code: 'E0' }, { event_code: 'E1' }, { event_code: 'E3' }],
    event_observability: 'FULL',
  }));
  // E2 未成立 → E3 NOT_ELIGIBLE
  assert.strictEqual(r.states.E2, 'FALSE');
  assert.strictEqual(r.states.E3, 'NOT_ELIGIBLE');
});
t('観測FULLでイベント無し → FALSE（観測可能だったのに発生せず）', () => {
  const r = engine.resolveCall(baseCall({
    canonicalEvents: [{ event_code: 'E0' }, { event_code: 'E1' }, { event_code: 'E2' }],
    event_observability: 'FULL',
  }));
  assert.strictEqual(r.states.E2, 'TRUE');
  assert.strictEqual(r.states.E4, 'FALSE');
});
t('観測NONEでtranscriptイベント → UNKNOWN（分母外）', () => {
  const r = engine.resolveCall(baseCall({
    canonicalEvents: [{ event_code: 'E0' }, { event_code: 'E1' }, { event_code: 'E2' }],
    event_observability: 'NONE',
  }));
  assert.strictEqual(r.states.E4, 'UNKNOWN');
  // 構造化(E0-E2)は NONE でも FALSE/TRUE 確定
  assert.strictEqual(r.states.E2, 'TRUE');
});
t('E7: 強度2以上かつ created のみ TRUE', () => {
  const strong = engine.resolveCall(baseCall({
    canonicalEvents: [
      { event_code: 'E0' }, { event_code: 'E1' }, { event_code: 'E2' },
      { event_code: 'E7', subtype: 'tentative_booking', next_step_disposition: 'created' },
    ],
  }));
  assert.strictEqual(strong.states.E7, 'TRUE');
  const weak = engine.resolveCall(baseCall({
    canonicalEvents: [
      { event_code: 'E0' }, { event_code: 'E1' }, { event_code: 'E2' },
      { event_code: 'E7', subtype: 'vague_permission_to_call', next_step_disposition: 'created' },
    ],
  }));
  assert.strictEqual(weak.states.E7, 'FALSE'); // 記録のみ・成立せず
});
t('E8: pending 窓内=UNKNOWN, 窓超過=FALSE, held=TRUE', () => {
  const nowSec = 100 * 86400;
  const held = engine.resolveE8Call([{ next_step_outcome: 'held', occurred_at_epoch: nowSec }], nowSec, 30);
  assert.strictEqual(held, 'TRUE');
  const inWin = engine.resolveE8Call([{ next_step_outcome: 'pending', occurred_at_epoch: nowSec - 10 * 86400 }], nowSec, 30);
  assert.strictEqual(inWin, 'UNKNOWN');
  const overWin = engine.resolveE8Call([{ next_step_outcome: 'pending', occurred_at_epoch: nowSec - 40 * 86400 }], nowSec, 30);
  assert.strictEqual(overWin, 'FALSE');
});
t('E8: created E7 が無ければ NOT_ELIGIBLE', () => {
  const r = engine.resolveCall(baseCall({
    canonicalEvents: [{ event_code: 'E0' }, { event_code: 'E1' }, { event_code: 'E2' }],
  }));
  assert.strictEqual(r.states.E8, 'NOT_ELIGIBLE');
});
t('path_pattern: 高信頼順序で連結, 順序不明で UNKNOWN_SEQUENCE', () => {
  const good = engine.resolveCall(baseCall({
    canonicalEvents: [
      { event_code: 'E0', event_order: 1, sequence_quality: 'exact' },
      { event_code: 'E1', event_order: 2, sequence_quality: 'exact' },
      { event_code: 'E2', event_order: 3, sequence_quality: 'exact' },
      { event_code: 'E4', event_order: 4, sequence_quality: 'exact' },
    ],
  }));
  assert.strictEqual(good.path_pattern, 'E0>E1>E2>E4');
  const unk = engine.resolveCall(baseCall({
    canonicalEvents: [
      { event_code: 'E0', event_order: 1, sequence_quality: 'exact' },
      { event_code: 'E1', event_order: 2, sequence_quality: 'exact' },
      { event_code: 'E2', event_order: 3, sequence_quality: 'exact' },
      { event_code: 'E4', sequence_quality: 'unknown' },
    ],
  }));
  assert.strictEqual(unk.path_pattern, 'UNKNOWN_SEQUENCE');
  assert.strictEqual(unk.event_set, 'E0|E1|E2|E4');
});
t('max_event = TRUE の最大', () => {
  const r = engine.resolveCall(baseCall({
    canonicalEvents: [
      { event_code: 'E0' }, { event_code: 'E1' }, { event_code: 'E2' }, { event_code: 'E4' },
    ],
  }));
  assert.strictEqual(r.max_event, 'E4');
});
t('eventRequiredForPurpose: テンプレ結合（TRUE∧required=false は正常）', () => {
  const req = engine.eventRequiredForPurpose('NEW_PROSPECTING', {
    NEW_PROSPECTING: { required_events: ['E3', 'E4', 'E7'] },
  });
  assert.strictEqual(req.E4, true);
  assert.strictEqual(req.E8, false);
});

// ---------------- sampling ----------------
console.log('sampling:');
function mkCalls(n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push({ call_id: 'c' + i, source_event_id: 'S' + i, call_date: '2026-07-16' });
  return arr;
}
t('METRIC は決定的・再現可能（seed再現性）', () => {
  const calls = mkCalls(20);
  const a = sampling.selectTranscripts(calls, { metricSize: 7, diagnosticSize: 3 });
  const b = sampling.selectTranscripts(calls.slice().reverse(), { metricSize: 7, diagnosticSize: 3 });
  assert.deepStrictEqual(a.metric.slice().sort(), b.metric.slice().sort());
  assert.strictEqual(a.metric.length, 7);
});
t('E2≤metricSize なら全件METRIC', () => {
  const r = sampling.selectTranscripts(mkCalls(5), { metricSize: 7, diagnosticSize: 3 });
  assert.strictEqual(r.metric.length, 5);
});
t('DIAGNOSTIC は METRIC 除外後の優先通話', () => {
  const calls = mkCalls(15);
  calls[13].is_appointment = true; // 高スコア
  const r = sampling.selectTranscripts(calls, { metricSize: 7, diagnosticSize: 3 });
  const c13sel = r.selections.get('c13');
  assert.ok(c13sel === 'DIAGNOSTIC_PRIORITY' || c13sel === 'BOTH');
});
t('実験通話は必ず METRIC（両群FULL化）', () => {
  const calls = mkCalls(20);
  calls[19].experiment_tag = 'exp001';
  const r = sampling.selectTranscripts(calls, { metricSize: 7, diagnosticSize: 3 });
  assert.ok(r.metric.includes('c19'));
});
t('isOfficialEligible: FULL∧METRIC/BOTH のみ', () => {
  assert.strictEqual(sampling.isOfficialEligible('FULL', 'METRIC_SAMPLE'), true);
  assert.strictEqual(sampling.isOfficialEligible('FULL', 'BOTH'), true);
  assert.strictEqual(sampling.isOfficialEligible('FULL', 'DIAGNOSTIC_PRIORITY'), false);
  assert.strictEqual(sampling.isOfficialEligible('PARTIAL', 'METRIC_SAMPLE'), false);
});

console.log(`\ngchain-core: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
