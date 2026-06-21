'use strict';
// 差分層: 前回スナップショット ↔ 今回 を社単位で比較し、イベント列を出す。
// イベントは heat.js で重み付けされ、鮮度=今アツいかの根拠になる。
//
// イベント種別:
//   NEW            初出（前回いなかった社が出た）        ← 最強シグナル
//   REAPPEARED     復活（前回いた→消えた→また出た）
//   JOB_UP         求人数が増えた（delta=増分）          ← 採用を強化＝アツい
//   JOB_DOWN       求人数が減った（delta=減分・負）
//   NEW_GRAD_YEAR  新しい卒年が出た（次年度の設計に着手） ← 強いシグナル
//   NEW_QUERY      新しい職種・エリアに露出し始めた
//   GONE           消滅（前回いた→今回いない。加点せず減衰に任せる）

function diffCompany(prev, cur) {
  const events = [];
  if (!prev && cur) { events.push({ event: 'NEW', delta: cur.totalJobs }); return events; }
  if (prev && !cur) { events.push({ event: 'GONE', delta: -((prev && prev.totalJobs) || 0) }); return events; }
  if (!prev || !cur) return events;

  const d = cur.totalJobs - prev.totalJobs;
  if (d > 0) events.push({ event: 'JOB_UP', delta: d });
  else if (d < 0) events.push({ event: 'JOB_DOWN', delta: d });

  // 新しい卒年（前回に無く今回ある）
  const prevYears = new Set(prev.gradYears || []);
  const newYears = (cur.gradYears || []).filter((y) => !prevYears.has(y));
  for (const y of newYears) events.push({ event: 'NEW_GRAD_YEAR', delta: 1, detail: y });

  // 新しいクエリ露出（媒体横断で前回に無いクエリ）
  const prevQ = new Set();
  for (const s of Object.values(prev.sources || {})) for (const q of s.queries || []) prevQ.add(q);
  const curQ = new Set();
  for (const s of Object.values(cur.sources || {})) for (const q of s.queries || []) curQ.add(q);
  const newQ = [...curQ].filter((q) => !prevQ.has(q));
  for (const q of newQ) events.push({ event: 'NEW_QUERY', delta: 1, detail: q });

  return events;
}

// 全社の差分。REAPPEARED は heat.js が「過去にfirstSeenあり & 今NEW」で判定するため、
// ここでは prev基準の純粋な集合差分（NEW/GONE/変化）だけを返す。
// 戻り値: { [key]: { 企業名, cur, prev, events:[...] } }
function diffSnapshots(prevSnap, curSnap) {
  const prev = (prevSnap && prevSnap.companies) || {};
  const cur = (curSnap && curSnap.companies) || {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(cur)]);
  const out = {};
  for (const key of keys) {
    const events = diffCompany(prev[key], cur[key]);
    if (!events.length) continue;
    out[key] = { 企業名: (cur[key] || prev[key]).企業名, cur: cur[key] || null, prev: prev[key] || null, events };
  }
  return out;
}

module.exports = { diffSnapshots, diffCompany };
