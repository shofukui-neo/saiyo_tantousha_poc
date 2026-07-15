'use strict';
/**
 * G-Chain OS v2.0 — 再活性化タイミング（設計書 §4.4）。
 * リサイクル/ペンディングリードを構造化タイミング信号で再架電優先度付け。
 * 純関数（now/参照月は引数注入）。
 */

/** "YYYY年M月" / "YYYY-MM" / "M月" 等 → {y, m} または null。 */
function parseMonth(s, refYear) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/(\d{4})[年\-\/](\d{1,2})/);
  if (m) return { y: Number(m[1]), m: Number(m[2]) };
  m = t.match(/(\d{1,2})\s*月/);
  if (m) return { y: refYear, m: Number(m[1]) };
  return null;
}

/** ref（{y,m}）から target までの月数差（負=過去）。 */
function monthDiff(from, to) {
  return (to.y - from.y) * 12 + (to.m - from.m);
}

/**
 * 再活性化優先度スコア（設計書 §4.4）。0..100。高いほど今架電すべき。
 * signals:
 *   consider_timing（検討開始時期）・renewal_month（更新予定月）・
 *   next_action_date（失注後次回アクション日）・loss_date（失注日）
 * ref: { y, m, today('YYYY-MM-DD') }
 */
function reactivationPriority(signals, ref) {
  let score = 0;
  const reasons = [];

  // 検討開始時期が「今月〜来月」→ 最優先
  const consider = parseMonth(signals.consider_timing, ref.y);
  if (consider) {
    const d = monthDiff(ref, consider);
    if (d >= 0 && d <= 1) { score += 45; reasons.push('検討開始が直近(' + d + 'ヶ月)'); }
    else if (d === 2) { score += 20; reasons.push('検討開始2ヶ月先'); }
  }

  // 更新予定月が近い（乗換好機は更新1-2ヶ月前）
  const renewal = parseMonth(signals.renewal_month, ref.y);
  if (renewal) {
    const d = monthDiff(ref, renewal);
    if (d >= 1 && d <= 2) { score += 35; reasons.push('更新' + d + 'ヶ月前(乗換好機)'); }
    else if (d === 0) { score += 15; reasons.push('更新当月'); }
  }

  // 失注後次回アクション日が到来
  if (signals.next_action_date && ref.today && String(signals.next_action_date).slice(0, 10) <= ref.today) {
    score += 25; reasons.push('次回アクション日到来');
  }

  // 失注からの経過（3ヶ月以上寝かせた案件は再打診好機・ただし1年超は減衰）
  if (signals.loss_date) {
    const days = daysBetween(signals.loss_date, ref.today);
    if (days != null) {
      if (days >= 90 && days <= 365) { score += 15; reasons.push('失注から' + days + '日(再打診好機)'); }
      else if (days > 365) { score -= 10; reasons.push('失注1年超(減衰)'); }
    }
  }

  return { priority: Math.max(0, Math.min(100, score)), reasons };
}

function daysBetween(from, to) {
  const a = toEpochDay(from), b = toEpochDay(to);
  if (a == null || b == null) return null;
  return b - a;
}
function toEpochDay(s) {
  const m = String(s || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

module.exports = { parseMonth, monthDiff, reactivationPriority };
