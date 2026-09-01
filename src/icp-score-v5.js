'use strict';
/**
 * ICPスコア v5 ── 2段の期待値モデル（2026-08-27）
 * =====================================================================
 * 6次元の加重和（v4）は廃止。「接触前に分かることだけ」で、コールド架電の“並べる順番”だけを決める。
 *
 *   total = 目盛り( p(接触) × p(アポ|接触) )
 *
 *   p(接触)      = 19.6% × 組織型 × 到達性 × 業種 × 規模        ← 母数 8,604架電
 *   p(アポ|接触) = 4.68% × 組織型 × 年間新卒採用人数            ← 母数 1,689接触
 *
 * ── 段に入れないもの（意図的な不採用）─────────────────────────
 *   業種は第2段に入れない（31業種中29業種が判定不能）。規模も第2段に入れない（単調にならない）。
 *   架電メモ由来の入力（新卒有無・利用媒体・検討時期）はどちらの段にも入れない ──
 *   「話が通った会社ほど点が高い」循環になり、コールド架電の順番を決める役に立たないため。
 *   ただし hot_signals として残し、追いかけはICP順の“上に固定”する（sortKey参照）。
 *
 * ── 実測での裏取り（捕捉曲線）──────────────────────────────
 *   並べ方      上位10%  上位30%  上位50%
 *   v4(加重和)    29%      53%      73%
 *   v5            28%      56%      75%
 *   70点未満 1,303架電でアポ2件（v4は2,175架電で6件）＝帯の下側に取りこぼしなし。
 *
 * 純ロジック・ネットワーク不要。ゲート（IT除外/官公庁/エントリー50名/DNC/既存顧客）は icp-rules.js 側。
 */

const { classifyOrgType, isNegativeLiftIndustry } = require('./icp-rules');

const flt = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);

// ── 係数表（env で上書き可。既定は実測値）───────────────────────
const V5 = {
  // 第1段: 受付を通るか（全体接触率19.6% / 母数8,604架電）
  BASE_CONTACT: flt(process.env.ICP_V5_BASE_CONTACT, 0.196),
  ORG_CONTACT: { public: 1.67, private: 0.84 },     // 公的・協同組合系 / 民間
  REACH_CONTACT: [                                   // 到達性C（電話妥当＋担当者名で90+）
    [90, 1.05, 'C90+(電話妥当＋担当者名)'],
    [70, 0.60, 'C70-89'],
    [50, 0.37, 'C50-69'],
    [0, 0.15, 'C50未満'],
  ],
  IND_NEG: 0.83,   // 負リフト群（IT・建設・機械・不動産・情報処理）
  IND_OTHER: 1.06, // それ以外（正リフトは全部中立化＝SFの勝ち業種は温かいリードの代理変数だった）
  SIZE_CONTACT: [                                    // 規模（従業員数）
    [1000, Infinity, 1.12, '1000+'],
    [500, 1000, 1.18, '500-1000'],
    [300, 500, 0.96, '300-500'],
    [100, 300, 0.82, '100-300'],
    [0, 100, 0.86, '100未満'],
  ],
  SIZE_UNKNOWN: 1.0, // 規模不明は中立（帯を動かさない）

  // 第2段: 通った先でアポになるか（接触後アポ率4.68% / 母数1,689接触）
  BASE_APPT: flt(process.env.ICP_V5_BASE_APPT, 0.0468),
  ORG_APPT: { public: 1.29, private: 0.86 },
  HIRE_APPT: [                                       // 年間新卒採用人数。分岐点は6名ではなく21名
    [21, Infinity, 1.50, '21名+'],
    [11, 21, 1.04, '11-20名'],
    [6, 11, 0.77, '6-10名'],
    [0, 6, 0.65, '5名以下'],
  ],
  HIRE_UNKNOWN: 0.93,

  // 目盛り: 期待アポ率(%) → 0-100点（log線形）。70点＝「今週架電」の帯。
  // モデルを変えても帯（70/50）は動かさない方針＝運用の意味を固定する。
  SCALE: [[0.05, 0], [0.15, 40], [0.44, 70], [3.0, 100]],
};

/** 到達性スコア(0-100) → 第1段の係数 */
function reachMultiplier(reachScore) {
  const c = Math.max(0, Math.min(100, Number(reachScore) || 0));
  for (const [min, mult, label] of V5.REACH_CONTACT) if (c >= min) return { mult, label: `到達性${label}×${mult}` };
  return { mult: 0.15, label: '到達性C50未満×0.15' };
}

/** 従業員数 → 第1段の係数（不明は中立1.0） */
function sizeMultiplier(emp) {
  if (emp == null || !Number.isFinite(emp)) return { mult: V5.SIZE_UNKNOWN, label: '規模不明×1.00' };
  for (const [lo, hi, mult, label] of V5.SIZE_CONTACT) if (emp >= lo && emp < hi) return { mult, label: `規模${label}×${mult}` };
  return { mult: V5.SIZE_UNKNOWN, label: '規模不明×1.00' };
}

/** 年間新卒採用人数 → 第2段の係数（不明は×0.93） */
function hireMultiplier(hire) {
  if (hire == null || !Number.isFinite(hire)) return { mult: V5.HIRE_UNKNOWN, label: '採用人数不明×0.93' };
  for (const [lo, hi, mult, label] of V5.HIRE_APPT) if (hire >= lo && hire < hi) return { mult, label: `採用${label}×${mult}` };
  return { mult: V5.HIRE_UNKNOWN, label: '採用人数不明×0.93' };
}

/** 第1段: 受付を通る確率 */
function contactRate({ orgType = 'private', reachScore = 0, industry = '', emp = null } = {}) {
  const org = V5.ORG_CONTACT[orgType] != null ? V5.ORG_CONTACT[orgType] : V5.ORG_CONTACT.private;
  const reach = reachMultiplier(reachScore);
  const neg = isNegativeLiftIndustry(industry);
  const ind = neg ? V5.IND_NEG : V5.IND_OTHER;
  const size = sizeMultiplier(emp);
  const p = V5.BASE_CONTACT * org * reach.mult * ind * size.mult;
  return {
    p,
    factors: { org, reach: reach.mult, industry: ind, size: size.mult },
    reasons: [
      `組織型${orgType === 'public' ? '公的・協同組合系' : '民間'}×${org}`,
      reach.label,
      `業種${neg ? '負リフト群(IT・建設・機械・不動産・情報処理)' : 'その他'}×${ind}`,
      size.label,
    ],
  };
}

/** 第2段: 通った先でアポになる確率 */
function apptRate({ orgType = 'private', hire = null } = {}) {
  const org = V5.ORG_APPT[orgType] != null ? V5.ORG_APPT[orgType] : V5.ORG_APPT.private;
  const h = hireMultiplier(hire);
  const p = V5.BASE_APPT * org * h.mult;
  return { p, factors: { org, hire: h.mult }, reasons: [`組織型×${org}(2段)`, h.label] };
}

/**
 * 期待アポ率(%) → 0-100点（アンカー間を log線形で内挿）。
 * 0.05%→0 / 0.15%→40 / 0.44%→70 / 3.0%→100。
 */
function toPoints(pct) {
  const A = V5.SCALE;
  if (!(pct > 0)) return 0;
  if (pct <= A[0][0]) return 0;
  if (pct >= A[A.length - 1][0]) return 100;
  for (let i = 0; i < A.length - 1; i++) {
    const [r0, p0] = A[i]; const [r1, p1] = A[i + 1];
    if (pct <= r1) return p0 + (p1 - p0) * (Math.log(pct / r0) / Math.log(r1 / r0));
  }
  return 100;
}

/**
 * v5 本体。接触前に分かることだけを受け取り、期待アポ率と目盛り点を返す。
 * @param {{company?:string, orgType?:'public'|'private', reachScore?:number, industry?:string, emp?:number|null, hire?:number|null}} v
 * @returns {{total:number, expectedPct:number, pContact:number, pAppt:number, orgType:string, orgLabel:string, factors:object, reasons:string[]}}
 */
function scoreV5({ company = '', orgType = null, reachScore = 0, industry = '', emp = null, hire = null } = {}) {
  const org = orgType ? { type: orgType, label: orgType === 'public' ? '公的・協同組合系' : '民間' } : classifyOrgType(company);
  const s1 = contactRate({ orgType: org.type, reachScore, industry, emp });
  const s2 = apptRate({ orgType: org.type, hire });
  const expectedPct = s1.p * s2.p * 100; // 期待アポ率（%）
  const total = Math.max(0, Math.min(100, Math.round(toPoints(expectedPct))));
  return {
    total,
    expectedPct,
    pContact: s1.p,
    pAppt: s2.p,
    orgType: org.type,
    orgLabel: org.label,
    factors: { contact: s1.factors, appt: s2.factors },
    reasons: []
      .concat(s1.reasons.map((r) => '接触:' + r))
      .concat(s2.reasons.map((r) => 'アポ:' + r))
      .concat([`期待アポ率${expectedPct.toFixed(3)}%→${total}点`]),
  };
}

module.exports = { V5, scoreV5, contactRate, apptRate, toPoints, reachMultiplier, sizeMultiplier, hireMultiplier };
