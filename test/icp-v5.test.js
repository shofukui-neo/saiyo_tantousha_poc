'use strict';
/**
 * ICPスコア v5：2段の期待値モデル＋絶対条件ゲート 検証
 * =====================================================================
 *   total = 目盛り( p(接触) × p(アポ|接触) )
 * 「接触前に分かることだけで並べる」ことと、ゲート（IT/官公庁/エントリー50名/DNC/既存顧客）が
 * “点の高低ではなく出口ブロック”として効くことを固定する。
 *
 * 単体実行: node test/icp-v5.test.js   （selftest からも呼ばれる）
 */
const { scoreV5, toPoints, V5 } = require('../src/icp-score-v5');
const { isGovernmentOrg, classifyOrgType, passesEntryFloor, qualifiesForList, ICP } = require('../src/icp-rules');
const { scoreMochica, sortKey } = require('../src/mochica-fit');

function testIcpV5() {
  let fail = 0;
  const ok = (label, cond) => { if (cond) console.log('✓ ' + label); else { console.log('✗ ' + label); fail++; } };
  const now = new Date('2026-09-15T00:00:00+09:00');

  // ── 目盛り: 0.05%→0 / 0.15%→40 / 0.44%→70 / 3.0%→100（log線形）。70点＝「今週架電」の帯 ──
  ok('toPoints: アンカー4点が一致',
    toPoints(0.05) === 0 && Math.round(toPoints(0.15)) === 40 &&
    Math.round(toPoints(0.44)) === 70 && toPoints(3.0) === 100);
  ok('toPoints: 単調増加', toPoints(0.1) < toPoints(0.2) && toPoints(0.2) < toPoints(1.0));
  ok('toPoints: 帯の外は0/100でクリップ', toPoints(0.01) === 0 && toPoints(10) === 100);
  ok('V5: 基準率 接触19.6%・アポ4.68%', V5.BASE_CONTACT === 0.196 && V5.BASE_APPT === 0.0468);

  // ── 組織型（最大の効き。接触2.1倍・アポ4.4倍）──
  const priv = scoreV5({ company: '株式会社サンプル', reachScore: 90, emp: 300, hire: 10 });
  const pub = scoreV5({ company: 'JAあいち中央', reachScore: 90, emp: 300, hire: 10 });
  ok('scoreV5: 公的・協同組合系 > 民間（同条件）', pub.total > priv.total && pub.orgType === 'public');
  ok('classifyOrgType: 信金/生協/社福は公的側、株式会社は民間',
    classifyOrgType('東海労働金庫').type === 'public' &&
    classifyOrgType('コープさっぽろ生活協同組合').type === 'public' &&
    classifyOrgType('社会福祉法人みらい会').type === 'public' &&
    classifyOrgType('株式会社ネオキャリア').type === 'private');

  // ── 到達性: 電話妥当＋担当者名(C90+)が最上位 ──
  const c90 = scoreV5({ company: '株式会社A', reachScore: 90, emp: 300 });
  const c60 = scoreV5({ company: '株式会社A', reachScore: 60, emp: 300 });
  const c00 = scoreV5({ company: '株式会社A', reachScore: 0, emp: 300 });
  ok('scoreV5: 到達性 C90+ > C50-69 > C50未満', c90.total > c60.total && c60.total > c00.total);

  // ── 規模: 500-1000がピーク。1000名超の罰はv4で撤回済み ──
  const s800 = scoreV5({ company: '株式会社A', reachScore: 90, emp: 800 });
  const s150 = scoreV5({ company: '株式会社A', reachScore: 90, emp: 150 });
  const s3000 = scoreV5({ company: '株式会社A', reachScore: 90, emp: 3000 });
  ok('scoreV5: 規模500-1000がピーク（100-300を上回る）', s800.total > s150.total);
  ok('scoreV5: 1000名超を沈めない（v4の罰は撤回）', s3000.total > s150.total);

  // ── 採用人数: 分岐点は6名ではなく21名。不明は落とさない ──
  const h25 = scoreV5({ company: '株式会社A', reachScore: 90, emp: 300, hire: 25 });
  const h15 = scoreV5({ company: '株式会社A', reachScore: 90, emp: 300, hire: 15 });
  const h8 = scoreV5({ company: '株式会社A', reachScore: 90, emp: 300, hire: 8 });
  const h3 = scoreV5({ company: '株式会社A', reachScore: 90, emp: 300, hire: 3 });
  const hNA = scoreV5({ company: '株式会社A', reachScore: 90, emp: 300, hire: null });
  ok('scoreV5: 採用21名+が最上位（分岐点は21名）',
    h25.total > h15.total && h15.total > h8.total && h8.total > h3.total);
  ok('scoreV5: 採用人数不明は5名以下より上（落とさない）', hNA.total > h3.total);

  // ── 業種: 負リフト群だけ×0.83。正リフトは全部中立化 ──
  const indNeg = scoreV5({ company: '株式会社A', reachScore: 90, emp: 300, industry: '建設' });
  const indOther = scoreV5({ company: '株式会社A', reachScore: 90, emp: 300, industry: '流通・小売・物販' });
  const indBlank = scoreV5({ company: '株式会社A', reachScore: 90, emp: 300, industry: '' });
  ok('scoreV5: 負リフト群(建設)は減衰', indNeg.total < indOther.total);
  ok('scoreV5: 正リフト業種は中立化（業種空欄と同点）', indOther.total === indBlank.total);

  const base = { '企業名': '株式会社サンプル', '従業員数': '300', '電話番号': '03-1234-5678', '採用担当者名': '山田太郎', '新卒フラグ': '○' };
  const plain = scoreMochica(base, { now });

  // ── ゲート①: IT・ソフトウェアは12点で頭打ち ──
  const it = scoreMochica(Object.assign({}, base, { '業種': 'ソフトウエア' }), { now });
  ok('gate: IT・ソフトは total<=12 で頭打ち', it.total <= 12 && it.flags.hardExclude === true);

  // ── ゲート②: 官公庁（県庁・市役所系）は3出口ブロック。外郭は残す ──
  ok('isGovernmentOrg: 県庁/市役所/自治体名/省庁を検出',
    isGovernmentOrg('青森県庁') && isGovernmentOrg('伊勢崎市役所') &&
    isGovernmentOrg('横浜市') && isGovernmentOrg('厚生労働省'));
  ok('isGovernmentOrg: 外郭（公社・事業団・独法・社協・共済組合）は含めない',
    !isGovernmentOrg('青森県住宅供給公社') && !isGovernmentOrg('日本下水道事業団') &&
    !isGovernmentOrg('独立行政法人国際交流基金') && !isGovernmentOrg('横浜市社会福祉協議会') &&
    !isGovernmentOrg('地方職員共済組合'));
  ok('isGovernmentOrg: 法人格つき（株式会社横浜市場）は民間', !isGovernmentOrg('株式会社横浜市場'));
  const gov = scoreMochica(Object.assign({}, base, { '企業名': '横浜市' }), { now });
  ok('gate: 官公庁は total=0・優先度=除外',
    gov.total === 0 && gov.priority === '除外' && gov.flags.govExcluded === true);
  ok('gate: 官公庁は qualifiesForList も不合格',
    qualifiesForList({ company: '横浜市', contactName: '山田', phone: '03-1', hire: 10, emp: 300 }).pass === false);

  // ── ゲート③: エントリー50名以上。未取得は通す（架電で聞いて初めて入る値） ──
  ok('ICP_ENTRY_MIN 既定=50', ICP.ENTRY_MIN === 50);
  ok('passesEntryFloor: 未取得(null)は通す', passesEntryFloor(null).pass === true);
  ok('passesEntryFloor: 判明50未満だけ落とす', passesEntryFloor(20).pass === false && passesEntryFloor(50).pass === true);
  const eLow = scoreMochica(Object.assign({}, base, { 'エントリー数': '20' }), { now });
  ok('gate: エントリー20名は total=0・除外', eLow.total === 0 && eLow.flags.entryExcluded === true);
  ok('gate: エントリー未取得は落とさない', plain.total > 0 && plain.flags.entryExcluded === false);
  ok('gate: 未取得は通し、判明50未満だけ qualifiesForList を落とす',
    qualifiesForList({ company: '株式会社A', contactName: '山田', phone: '03-1', hire: 10, emp: 300 }).pass === true &&
    qualifiesForList({ company: '株式会社A', contactName: '山田', phone: '03-1', hire: 10, emp: 300, entry: 20 }).pass === false);

  // ── ゲート④: DNC −100 / 既存顧客 −70。競合ATS・1000名超の罰は撤回 ──
  const dnc = scoreMochica(Object.assign({}, base, { 'DNC': '○' }), { now });
  const cust = scoreMochica(Object.assign({}, base, { '既存顧客': '○' }), { now });
  const ats = scoreMochica(Object.assign({}, base, { '競合ATS導入': '○' }), { now });
  ok('gate: DNCは沈む（−100）', dnc.total === 0);
  ok('gate: 既存顧客は沈む（−70）', cust.total < plain.total - 50);
  ok('撤回: 競合ATS導入で減点しない（v4の−45を廃止）', ats.total === plain.total);

  // ── hot_signals: 総合点には入れない。ただし追いかけはICP順の上に固定 ──
  const hot = scoreMochica(Object.assign({}, base, { '辞退シグナル': '○' }), { now });
  ok('hot_signals: 辞退シグナルは総合点を動かさない', hot.total === plain.total);
  ok('hot_signals: 旗が立ち sortKey でICP順の上に来る',
    hot.flags.hot === true && sortKey(hot) > sortKey(plain) + 100);

  // ── 監査用の内訳 ──
  ok('scoreMochica: 期待アポ率と2段の確率を返す',
    typeof plain.expectedPct === 'number' && plain.pContact > 0 && plain.pAppt > 0 && plain.orgLabel === '民間');

  return fail;
}

module.exports = { testIcpV5 };

if (require.main === module) {
  const fail = testIcpV5();
  if (fail > 0) { console.error(`\nICP v5 TEST FAILED: ${fail} case(s)`); process.exit(1); }
  console.log('\nICP v5 TEST PASSED ✓');
}
