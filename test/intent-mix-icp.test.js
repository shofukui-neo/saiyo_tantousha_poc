'use strict';
/**
 * 採用構成（S30 / 新卒中心の判定）と ICP v5.1 の検証。
 *
 * ここで固定したい事故:
 *   - 求人ボックスに社名一致カードが1枚も出なかっただけの社を「中途0件＝新卒中心(確定)」にする
 *     （実測 2026-09-18・日本無線(株): 「日本無線 中途採用」で25枚返るのに社名一致は0枚）
 *   - その社自身の新卒求人カードを「中途の求人」として数える
 *   - 採用ページの語の量（寄り）だけで「中途中心」と断定してICPから落とす
 *   - 仮説係数（採用構成）と実測フィットの係数が混ざって、どちらで点が動いたか追えなくなる
 */
const assert = require('assert');
const { classifyHiringMix, passesNewgradCentric, resolveIcpInputs, qualifiesForList, passesIcpFloor, MIX, ICP } = require('../src/icp-rules');
const { hiringMix, estimateMidcareer, newgradScale, detectMixSignals } = require('../src/intent/mix-signals');
const { scoreV5, mixMultiplier, V5 } = require('../src/icp-score-v5');
const { parseJobCards } = require('../src/intent/collect');
const { SIGNAL_LIST } = require('../src/intent/signals');

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✔ ' + name); } catch (e) { console.error('  ✘ ' + name); throw e; } };
const NOW = new Date('2026-09-18T00:00:00Z');
const D = '2026-09-18';
const face = (下限, 表記) => ({ 27: { 募集人数: { 下限, 上限: 下限, 表記: 表記 || `${下限}名` } } });

// ---- 採用構成の判定 ----------------------------------------------------
t('新卒 ≥ 中途 なら新卒中心、新卒×2以上の中途なら中途中心', () => {
  assert.strictEqual(classifyHiringMix({ newgrad: 10, midcareer: 2, midcareerFetched: true }).構成, MIX.NEWGRAD);
  assert.strictEqual(classifyHiringMix({ newgrad: 10, midcareer: 10, midcareerFetched: true }).構成, MIX.NEWGRAD);
  assert.strictEqual(classifyHiringMix({ newgrad: 3, midcareer: 25, midcareerFetched: true }).構成, MIX.MIDCAREER);
  assert.strictEqual(classifyHiringMix({ newgrad: 10, midcareer: 14, midcareerFetched: true }).構成, MIX.BOTH);
});

t('中途件数が少ないうちは中途中心と言わない（件数の下限）', () => {
  // 新卒1名・中途3件は比では3倍だが、件数が MIDCAREER_MIN_COUNT 未満なので断定しない
  assert.strictEqual(ICP.MIDCAREER_MIN_COUNT, 5);
  assert.strictEqual(classifyHiringMix({ newgrad: 1, midcareer: 3, midcareerFetched: true }).構成, MIX.BOTH);
  assert.strictEqual(classifyHiringMix({ newgrad: 1, midcareer: 6, midcareerFetched: true }).構成, MIX.MIDCAREER);
});

t('「取得して0件」と「取得していない」を区別する', () => {
  assert.strictEqual(classifyHiringMix({ newgrad: 10, midcareer: null, midcareerFetched: true }).構成, MIX.NEWGRAD);
  assert.strictEqual(classifyHiringMix({ newgrad: 10, midcareer: null, midcareerFetched: false }).構成, MIX.UNKNOWN);
});

t('新卒が0名・新卒不明はそれぞれ別の扱い', () => {
  assert.strictEqual(classifyHiringMix({ newgrad: 0, midcareer: 3, midcareerFetched: true }).構成, MIX.NONE);
  assert.strictEqual(classifyHiringMix({ newgrad: null, midcareer: 3, midcareerFetched: true }).構成, MIX.UNKNOWN);
});

// ---- ゲート ------------------------------------------------------------
t('ゲートは中途中心・新卒なしだけを落とす（不明・併用は通す）', () => {
  const g = (c) => passesNewgradCentric({ 構成: c, 理由: 'x' }).pass;
  assert.strictEqual(g(MIX.MIDCAREER), false);
  assert.strictEqual(g(MIX.NONE), false);
  assert.strictEqual(g(MIX.UNKNOWN), true);
  assert.strictEqual(g(MIX.BOTH), true);
  assert.strictEqual(g(MIX.NEWGRAD), true);
});

t('中途中心はリスト掲載の絶対条件で落ちる', () => {
  const base = { company: '株式会社サンプル', contactName: '山田', phone: '03-0000-0000', hire: 10, emp: 300 };
  assert.strictEqual(qualifiesForList(base).pass, true);
  const mid = qualifiesForList({ ...base, mix: classifyHiringMix({ newgrad: 3, midcareer: 25, midcareerFetched: true }) });
  assert.strictEqual(mid.pass, false);
  assert.strictEqual(mid.blocked, true);
  assert.ok(mid.reasons.some((r) => r.includes('中途中心')), mid.reasons.join('/'));
});

t('mix を渡さない従来の呼び出しは挙動が変わらない', () => {
  assert.strictEqual(passesIcpFloor({ emp: 300, hire: 10 }).pass, true);
  assert.strictEqual(passesIcpFloor({ emp: 300, hire: 10, mix: null }).pass, true);
});

// ---- 求人カードの数え方 -------------------------------------------------
t('その社自身の新卒求人カードは中途の件数に数えない', () => {
  // 求人ボックスの実DOM（2026-09 較正）を縮めたもの
  const html = ['<div class="p-result_card"><span class="p-result_companyName">日本無線</span>',
    '<span class="p-result_name">2027 新卒採用 コンピュータ・通信機器</span></div>',
    '<div class="p-result_card"><span class="p-result_companyName">日本無線</span>',
    '<span class="p-result_name">回路設計（中途）</span></div>'].join('');
  const cards = parseJobCards(html, 'x');
  assert.strictEqual(cards.length, 2);
  const 新卒RE = /((?:20\d{2}|\d{2})\s*年?\s*卒|新卒採用)/;
  assert.strictEqual(cards.filter((c) => !新卒RE.test(`${c.職種} ${c.本文}`)).length, 1);
});

t('社名一致が0枚の回は「中途0件」ではなく未取得として扱う', () => {
  // collect.js が返す形をそのまま置く
  const ev = { 卒年面: face(10), 中途求人: { 件数: null, 取得: false, 出所: '求人ボックス', 理由: '社名一致の求人カードなし(索引に出ていない可能性)' } };
  assert.strictEqual(estimateMidcareer(ev).取得, false);
  assert.strictEqual(hiringMix(ev).構成, MIX.UNKNOWN);
  assert.strictEqual(detectMixSignals(ev, { now: NOW, 検知日: D }).length, 0);
});

// ---- S30 --------------------------------------------------------------
t('新卒が中途の倍以上なら確定、拮抗していれば強', () => {
  const 倍 = detectMixSignals({ 卒年面: face(10), 中途求人: { 件数: 2, 取得: true, 出所: '求人ボックス', 例: ['営業'] } }, { now: NOW, 検知日: D })[0];
  assert.ok(/^確定/.test(倍.level), 倍.level);
  assert.ok(倍.根拠.includes('単位が違う'), '単位の違いを根拠文に残す');
  const 拮抗 = detectMixSignals({ 卒年面: face(10), 中途求人: { 件数: 8, 取得: true, 出所: '求人ボックス', 例: [] } }, { now: NOW, 検知日: D })[0];
  assert.ok(/^強/.test(拮抗.level), 拮抗.level);
});

t('中途中心の社ではS30を立てない（減点シグナルも作らない）', () => {
  const ev = { 卒年面: face(3), 中途求人: { 件数: 25, 取得: true, 出所: '求人ボックス', 例: [] } };
  assert.strictEqual(detectMixSignals(ev, { now: NOW, 検知日: D }).length, 0);
  assert.strictEqual(hiringMix(ev).構成, MIX.MIDCAREER);
});

t('件数が取れない時は採用ページの語で弱く採り、中途寄りでは何も断定しない', () => {
  const 新卒寄り = { 卒年面: face(10), 自社サイト本文: '2027年卒の新卒採用を行っています。会社説明会、エントリーシートの受付中。' };
  const h = detectMixSignals(新卒寄り, { now: NOW, 検知日: D })[0];
  assert.ok(/^弱/.test(h.level), h.level);
  assert.strictEqual(hiringMix(新卒寄り).確度, '弱');
  const 中途寄り = { 卒年面: face(10), 自社サイト本文: '中途採用・キャリア採用を実施中。経験者歓迎、職務経歴書をお送りください。' };
  assert.strictEqual(hiringMix(中途寄り).構成, MIX.UNKNOWN, '語の量だけで中途中心と断定しない');
  assert.strictEqual(passesNewgradCentric(hiringMix(中途寄り)).pass, true);
});

t('マイナビ掲載本文からは寄りを読まない（構造上100%新卒＝循環になる）', () => {
  const ev = { 卒年面: face(10), 掲載本文: '2027年卒 新卒採用 会社説明会 エントリーシート 内々定' };
  assert.strictEqual(hiringMix(ev).構成, MIX.UNKNOWN);
  assert.strictEqual(detectMixSignals(ev, { now: NOW, 検知日: D }).length, 0);
});

t('新卒の規模は 募集人数 → 入社実績 → 採用予定人数 の順に見る', () => {
  assert.strictEqual(newgradScale({ 卒年面: face(12) }).人数, 12);
  assert.strictEqual(newgradScale({ 定着: { 系列: [{ 年: 2025, 採用者: 7, 離職者: 0, 定着率: 100 }] } }).人数, 7);
  assert.strictEqual(newgradScale({ 採用予定人数: '5名' }).人数, 5);
  assert.strictEqual(newgradScale({}).人数, null);
});

// ---- ICP入力の充填 -----------------------------------------------------
t('CSVが空でも掲載面から従業員数・新卒人数を埋め、出所を残す', () => {
  const rec = { 企業名: '株式会社サンプル', 業種: '製造' };
  const ev = { 会社データ: { 従業員数: 407, 売上高: 2.1e10 }, 卒年面: face(11, '11～15名') };
  const r = resolveIcpInputs(rec, ev);
  assert.strictEqual(r.emp, 407);
  assert.strictEqual(r.hire, 11);
  assert.strictEqual(r.出所.emp, '掲載面');
  assert.strictEqual(r.出所.hire, '掲載面(募集人数)');
  // CSVに値があればそちらが勝つ
  const r2 = resolveIcpInputs({ ...rec, 従業員数: '250', 年間新卒採用人数: '8' }, ev);
  assert.deepStrictEqual([r2.emp, r2.hire, r2.出所.emp], [250, 8, 'CSV']);
});

// ---- ICP v5.1 ----------------------------------------------------------
t('v5.1: 採用構成は第2段の係数。新卒中心 > 不明 > 中途中心', () => {
  const s = (mix) => scoreV5({ company: '株式会社A', reachScore: 90, emp: 400, hire: 12, mix }).total;
  assert.ok(s('新卒中心') > s(null), '新卒中心が不明を上回る');
  assert.ok(s(null) > s('中途中心'), '中途中心は沈む');
  assert.strictEqual(s(null), s('併用'), '併用は中立（不明と同点）');
});

t('v5.1: 仮説係数は実測フィットの係数と分けて返す', () => {
  const r = scoreV5({ company: '株式会社A', reachScore: 90, emp: 400, hire: 12, mix: '新卒中心' });
  assert.strictEqual(r.factors.仮説.mix, V5.MIX_APPT.新卒中心);
  assert.strictEqual(r.factors.appt.mix, undefined, '仮説を appt の実測係数に混ぜない');
  assert.strictEqual(r.hiringMix, '新卒中心');
  assert.ok(r.reasons.some((x) => x.includes('仮説')), r.reasons.join('/'));
});

t('v5.1: ICP_V5_MIX=off で v5.0 の採点に戻せる', () => {
  const saved = V5.MIX_ENABLED;
  try {
    V5.MIX_ENABLED = false;
    assert.strictEqual(mixMultiplier('新卒中心').mult, 1);
    assert.strictEqual(mixMultiplier('中途中心').mult, 1);
  } finally { V5.MIX_ENABLED = saved; }
});

t('S30 は列・順位が一意で既存29軸と衝突しない', () => {
  assert.strictEqual(SIGNAL_LIST.length, 30);
  assert.strictEqual(new Set(SIGNAL_LIST.map((s) => s.列)).size, 30);
  assert.strictEqual(SIGNAL_LIST.find((s) => s.id === 'NEWGRAD_CENTRIC').列, 'S30_新卒中心');
});

console.log('採用構成・ICP v5.1: ' + pass + ' pass');
