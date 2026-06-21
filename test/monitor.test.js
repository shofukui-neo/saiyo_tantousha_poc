'use strict';
// モニタリング層の決定論的テスト（ネットワーク非依存）。
// 合成スナップショットで diff/heat/recency/ソース間公平化/autonomy のロジックを回帰保護する。
//   node test/monitor.test.js
const { parseRecencyDays } = require('../src/monitor/snapshot');
const { diffSnapshots } = require('../src/monitor/diff');
const { applyCycle, rank, eventWeight, icpFactor, recencyFactor } = require('../src/monitor/heat');
const autonomy = require('../src/monitor/autonomy');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg}（期待 ${b} / 実際 ${a}）`); }
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, `${msg}（期待≈${b} / 実際 ${a}）`); }

// ── parseRecencyDays（真の掲載日）──
(function () {
  eq(parseRecencyDays('新着'), 0, 'recency:新着→0');
  eq(parseRecencyDays('本日更新'), 0, 'recency:本日→0');
  eq(parseRecencyDays('3日前に掲載'), 3, 'recency:3日前→3');
  eq(parseRecencyDays('2週間前'), 14, 'recency:2週間前→14');
  eq(parseRecencyDays('5時間前'), 0, 'recency:5時間前→0');
  eq(parseRecencyDays('掲載なし普通の文'), null, 'recency:マーカー無→null');
  eq(parseRecencyDays('2020/01/01 設立'), null, 'recency:120日超の絶対日付→無視(null)');
  eq(parseRecencyDays('10日前 / 新着 / 3日前'), 0, 'recency:複数→最小(最新)');
})();

// ── eventWeight（イベント重み）──
(function () {
  eq(eventWeight('NEW'), 10, 'weight:NEW=10');
  eq(eventWeight('NEW_GRAD_YEAR'), 8, 'weight:NEW_GRAD_YEAR=8');
  eq(eventWeight('JOB_DOWN'), -1, 'weight:JOB_DOWN=-1');
  eq(eventWeight('GONE'), 0, 'weight:GONE=0(減衰に任せる)');
  near(eventWeight('JOB_UP', 3), 6, 1e-9, 'weight:JOB_UP delta3=3*log2(4)=6');
})();

// ── recencyFactor（鮮度係数）──
(function () {
  eq(recencyFactor(0), 1.5, 'recF:0日→1.5');
  eq(recencyFactor(3), 1.3, 'recF:3日→1.3');
  eq(recencyFactor(7), 1.15, 'recF:7日→1.15');
  eq(recencyFactor(14), 1.05, 'recF:14日→1.05');
  eq(recencyFactor(30), 1, 'recF:30日→1');
  eq(recencyFactor(null), 1, 'recF:不明→1(中立)');
})();

// ── icpFactor（ソース間公平化＝クエリ語でも職種intent判定）──
(function () {
  // スクレイプ職種は空でも、ヒットしたクエリ「新卒 営業 東京」で営業intent確定→×1.2
  const cQuery = { sources: { リクナビ: { jobs: [], queries: ['新卒 営業 東京'] } }, gradYears: [], recencyDays: null };
  near(icpFactor(cQuery), 1.2, 1e-9, 'icp:クエリ語のみでも営業×1.2（ソース間公平）');
  // 職種一致なし→1.0
  const cNone = { sources: { リクナビ: { jobs: [], queries: ['新卒 一般事務 東京'] } }, gradYears: [], recencyDays: null };
  eq(icpFactor(cNone), 1, 'icp:ICP外職種→1.0');
  // 鮮度0日が乗る→1.2*1.5=1.8
  const cFresh = { sources: { 求人ボックス: { jobs: ['新卒 営業'], queries: [] } }, gradYears: [], recencyDays: 0 };
  near(icpFactor(cFresh), 1.8, 1e-9, 'icp:営業×鮮度0日=1.8');
})();

// ── diffSnapshots（差分イベント）──
(function () {
  const mk = (totalJobs, gradYears, queries) => ({ 企業名: 'X社', totalJobs, gradYears, sources: { 求人ボックス: { queries } } });
  // NEW
  let d = diffSnapshots({ companies: {} }, { companies: { x: mk(2, [], ['q1']) } });
  ok(d.x && d.x.events.some((e) => e.event === 'NEW'), 'diff:初出→NEW');
  // GONE
  d = diffSnapshots({ companies: { x: mk(2, [], ['q1']) } }, { companies: {} });
  ok(d.x && d.x.events.some((e) => e.event === 'GONE'), 'diff:消滅→GONE');
  // JOB_UP delta
  d = diffSnapshots({ companies: { x: mk(2, [], ['q1']) } }, { companies: { x: mk(5, [], ['q1']) } });
  ok(d.x && d.x.events.some((e) => e.event === 'JOB_UP' && e.delta === 3), 'diff:求人増→JOB_UP delta3');
  // NEW_GRAD_YEAR
  d = diffSnapshots({ companies: { x: mk(2, [], ['q1']) } }, { companies: { x: mk(2, ['2027'], ['q1']) } });
  ok(d.x && d.x.events.some((e) => e.event === 'NEW_GRAD_YEAR' && e.detail === '2027'), 'diff:新卒年追加→NEW_GRAD_YEAR');
  // NEW_QUERY
  d = diffSnapshots({ companies: { x: mk(2, [], ['q1']) } }, { companies: { x: mk(2, [], ['q1', 'q2']) } });
  ok(d.x && d.x.events.some((e) => e.event === 'NEW_QUERY' && e.detail === 'q2'), 'diff:新領域→NEW_QUERY');
  // 変化なし→出力に含めない
  d = diffSnapshots({ companies: { x: mk(2, [], ['q1']) } }, { companies: { x: mk(2, [], ['q1']) } });
  ok(!d.x, 'diff:変化なし→出力しない');
})();

// ── applyCycle（減衰＋加点）と rank（鮮度タイブレーク）──
(function () {
  const now = '2026-06-19T00:00:00.000Z';
  const snap = { companies: {
    a: { 企業名: 'A', totalJobs: 1, gradYears: [], recencyDays: 0, sources: { 求人ボックス: { jobs: ['新卒 営業'], queries: ['新卒 営業 東京'] } } },
    b: { 企業名: 'B', totalJobs: 1, gradYears: [], recencyDays: 20, sources: { 求人ボックス: { jobs: ['新卒 営業'], queries: ['新卒 営業 東京'] } } },
  } };
  const deltas = diffSnapshots({ companies: {} }, snap);
  const st = applyCycle({}, deltas, snap, { now, nextGradYears: [] });
  // A: NEW10 × (営業1.2 × 鮮度0日1.5)=18 / B: NEW10 × (1.2 × 鮮度20日1.0)=12
  near(st.a.heat, 18, 1e-6, 'applyCycle:A=NEW×営業×鮮度0日=18');
  near(st.b.heat, 12, 1e-6, 'applyCycle:B=NEW×営業×鮮度20日=12');

  // 減衰: 半減期(既定72h)経過で半分
  const later = '2026-06-22T00:00:00.000Z'; // +72h
  const st2 = applyCycle(JSON.parse(JSON.stringify(st)), {}, { companies: {} }, { now: later, nextGradYears: [], halfLifeH: 72 });
  near(st2.a.heat, 9, 1e-3, 'applyCycle:72h後にAは半減(18→9)');

  // rank: heat降順、同点は掲載日が新しい順
  const tieSnap = { companies: {
    p: { 企業名: 'P', totalJobs: 1, gradYears: [], recencyDays: 15, sources: { s: { jobs: [], queries: ['新卒 営業'] } } },
    q: { 企業名: 'Q', totalJobs: 1, gradYears: [], recencyDays: 3, sources: { s: { jobs: [], queries: ['新卒 営業'] } } },
  } };
  // 同条件にするため recencyFactor差を打ち消す: ここでは別途heatを揃えた状態を作る
  const stTie = { p: { 企業名: 'P', heat: 5, lastEventTs: now, recencyDays: 15 }, q: { 企業名: 'Q', heat: 5, lastEventTs: now, recencyDays: 3 } };
  const r = rank(stTie, { now });
  eq(r[0].企業名, 'Q', 'rank:熱量同点なら掲載日が新しい方(Q:3日前)が上位');

  // REAPPEARED: 確定不在(missStreak>=2)だった既知社が再度NEW（点滅でなく真の復活）
  const stKnown = { a: { 企業名: 'A', heat: 1, firstSeen: now, lastEventTs: now, missStreak: 2, history: [] } };
  const reSnap = { companies: { a: { 企業名: 'A', totalJobs: 1, gradYears: [], recencyDays: null, sources: { s: { jobs: [], queries: ['x'] } } } } };
  const reDelta = diffSnapshots({ companies: {} }, reSnap); // a→NEW
  const stRe = applyCycle(stKnown, reDelta, reSnap, { now: later });
  ok((stRe.a.lastEvents || []).includes('REAPPEARED'), 'applyCycle:既知社の再NEW→REAPPEAREDに昇格');
})();

// ── autonomy.evolve（クエリ増殖／枯渇撤退）──
(function () {
  const st = { queries: { '新卒 営業 東京': { dry: 0, active: true, hits: 0 } }, cycle: 0 };
  const { added } = autonomy.evolve(st, { perQueryNew: { '新卒 営業 東京': 2 }, staleSources: [] });
  ok(added.length > 0, 'autonomy:多産クエリ(fresh>=2)→近接クエリ増殖');
  eq(st.queries['新卒 営業 東京'].dry, 0, 'autonomy:新規ありでdryリセット');

  // 枯渇撤退: DRY_LIMIT 連続ゼロで active=false
  const st2 = { queries: { '新卒 経理 福井': { dry: 0, active: true, hits: 0 } }, cycle: 0 };
  for (let i = 0; i < 5; i++) autonomy.evolve(st2, { perQueryNew: {}, staleSources: [] });
  eq(st2.queries['新卒 経理 福井'].active, false, 'autonomy:連続新規ゼロで休止(撤退)');
})();

// ── 偽差分抑制（多数決GONE）──
(function () {
  const snapA = { companies: { a: { 企業名: 'A', totalJobs: 1, gradYears: [], recencyDays: null, sources: { s: { jobs: [], queries: ['新卒'] } } } } };
  const empty = { companies: {} };
  // 点滅（present→absent1回→present）: REAPPEARED抑制・熱量が増えない（時刻は無効文字列→減衰0で判定を単純化）
  let st = applyCycle({}, diffSnapshots(empty, snapA), snapA, { now: 't1' });
  const h1 = st.a.heat;
  st = applyCycle(st, diffSnapshots(snapA, empty), empty, { now: 't2' });      // GONE, missStreak=1
  st = applyCycle(st, diffSnapshots(empty, snapA), snapA, { now: 't3' });      // 復帰 prevMiss=1<2→抑制
  ok(!(st.a.lastEvents || []).includes('REAPPEARED'), 'GONE抑制:点滅復帰はREAPPEAREDしない');
  near(st.a.heat, h1, 1e-9, 'GONE抑制:点滅で熱量が増えない');

  // 確定不在（absent>=2回）後の復帰はREAPPEARED
  let st2 = applyCycle({}, diffSnapshots(empty, snapA), snapA, { now: 't1' });
  st2 = applyCycle(st2, diffSnapshots(snapA, empty), empty, { now: 't2' });    // miss=1
  st2 = applyCycle(st2, diffSnapshots(empty, empty), empty, { now: 't3' });    // miss=2(確定不在)
  st2 = applyCycle(st2, diffSnapshots(empty, snapA), snapA, { now: 't4' });    // 復帰 prevMiss=2>=2→REAPPEARED
  ok((st2.a.lastEvents || []).includes('REAPPEARED'), 'GONE確定:2サイクル不在後の復帰はREAPPEARED');
})();

console.log(`\nmonitor.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
