'use strict';
/**
 * G-Chain OS v2.0 — 失注インテリジェンス（設計書 §4.3）。
 * 失注理由大の構造化コードを L/C/S 風の帰属に写像し、改善アクションを出す。
 * 心理診断の代替。ただし「切り返せたか(C/S)」は構造化では判定不能（§4.3.1の限界）。
 * 純関数（外部I/O無し）。
 */

// 失注理由大 → { attribution, action, actionable }
// attribution: L_TIMING / L_ICP / L_EXOGENOUS / C_PITCH / PRODUCT / PENDING / OTHER
const LOSS_MAP = {
  '検討時期相違': { attribution: 'L_TIMING', action: '検討開始時期でリスト再スケジュール（再活性化キューへ）', actionable: true },
  '情報収集': { attribution: 'PENDING', action: '情報収集段階→ナーチャリング後に再架電', actionable: true },
  'ニーズなし': { attribution: 'L_ICP', action: 'ICP適合の見直し（採用人数/業種のリスト条件を締める）', actionable: true },
  '予算なし（来期以降も不可）': { attribution: 'L_EXOGENOUS', action: '除外または長期再活性化（更新月まで休眠）', actionable: false },
  'リスケのため未商談': { attribution: 'PENDING', action: 'リスケ→次アクション日で再架電（フォロー規律で回収）', actionable: true },
  '競合負け(MOCHICA以外にお金かけたケース）': { attribution: 'C_PITCH', action: '競合別の訴求根拠を 10_訴求マスタ へ追加', actionable: true },
  '競合バッティング': { attribution: 'C_PITCH', action: '競合バッティング時の切り返しトークを整備', actionable: true },
  '先方理由': { attribution: 'L_EXOGENOUS', action: '外生要因→除外', actionable: false },
  '機能面': { attribution: 'PRODUCT', action: 'プロダクトへ機能要望をフィードバック', actionable: false },
  'その他': { attribution: 'OTHER', action: '理由中/小で再分類', actionable: false },
};

function classifyLoss(lossMajor) {
  const key = (lossMajor || '').trim();
  return LOSS_MAP[key] || { attribution: 'OTHER', action: '理由中/小で再分類', actionable: false };
}

/**
 * 失注理由分布と帰属集計（設計書 §4.3）。
 * lostRecords: 失注確定レコード（loss_reason_major を持つ想定）
 * lossFieldFn(rec) → 失注理由大の文字列
 */
function summarizeLoss(lostRecords, lossFieldFn) {
  const byReason = {};
  const byAttribution = {};
  let actionable = 0, total = 0;
  for (const r of lostRecords) {
    const reason = (lossFieldFn(r) || '').trim();
    if (!reason) continue;
    total++;
    byReason[reason] = (byReason[reason] || 0) + 1;
    const c = classifyLoss(reason);
    byAttribution[c.attribution] = (byAttribution[c.attribution] || 0) + 1;
    if (c.actionable) actionable++;
  }
  return {
    total,
    actionable_share: total ? round3(actionable / total) : null,
    by_reason: sortDesc(byReason),
    by_attribution: sortDesc(byAttribution),
    actions: Object.keys(byReason).map((reason) => ({
      reason, count: byReason[reason], ...classifyLoss(reason),
    })).sort((a, b) => b.count - a.count),
  };
}

function sortDesc(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, count: v }));
}
function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = { LOSS_MAP, classifyLoss, summarizeLoss };
