'use strict';
/**
 * G-Chain OS v2.0 — 行動規律（設計書 §4.5）。育成PDCAの実体（話し方でなく行動）。
 * 次のアクション（予定日時 vs 完了日時）からフォロー規律を測る。
 * 純関数（now/today は引数注入）。
 */

const { collectNextActions } = require('./bales-map');

/**
 * 1レコードの次アクション規律を集計。
 * 返り値: { planned, completed, overdue, avg_interval_days }
 * today: 'YYYY-MM-DD'（overdue 判定基準）
 */
function recordDiscipline(rec, today) {
  const actions = collectNextActions(rec);
  let planned = 0, completed = 0, overdue = 0, intervalSum = 0, intervalN = 0;
  for (const a of actions) {
    if (a.planned_at) planned++;
    if (a.done) {
      completed++;
      const iv = daysBetween(a.planned_at, a.done_at);
      if (iv != null) { intervalSum += iv; intervalN++; }
    } else if (a.planned_at && today && String(a.planned_at).slice(0, 10) < today) {
      overdue++;
    }
  }
  return {
    planned, completed, overdue,
    avg_interval_days: intervalN ? round1(intervalSum / intervalN) : null,
  };
}

/**
 * 所有者別（または全体）の行動規律ロールアップ（設計書 §4.5）。
 * records + ownerFn(rec)→所有者。ownerFn 省略で全体1グループ。
 */
function disciplineByOwner(records, today, ownerFn) {
  const groups = new Map();
  for (const r of records) {
    const owner = ownerFn ? (ownerFn(r) || '(不明)') : 'ALL';
    if (!groups.has(owner)) groups.set(owner, { planned: 0, completed: 0, overdue: 0, ivSum: 0, ivN: 0 });
    const g = groups.get(owner);
    const d = recordDiscipline(r, today);
    g.planned += d.planned; g.completed += d.completed; g.overdue += d.overdue;
    if (d.avg_interval_days != null) { g.ivSum += d.avg_interval_days; g.ivN++; }
  }
  const out = [];
  for (const [owner, g] of groups) {
    out.push({
      owner,
      planned: g.planned, completed: g.completed, overdue: g.overdue,
      follow_execution_rate: g.planned ? round3(g.completed / g.planned) : null,
      overdue_rate: g.planned ? round3(g.overdue / g.planned) : null,
      avg_interval_days: g.ivN ? round1(g.ivSum / g.ivN) : null,
    });
  }
  out.sort((a, b) => b.planned - a.planned);
  return out;
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
function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = { recordDiscipline, disciplineByOwner };
