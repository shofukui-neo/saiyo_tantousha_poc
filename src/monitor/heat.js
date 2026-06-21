'use strict';
// 熱量層: 差分イベントを「熱量(heat)」に変換し、時間で減衰させる。
//   - 動きのある社は加点で熱くなり、止まれば半減期で自然に冷める＝「今アツい＝鮮度の良い」を数値化。
//   - 状態は store.js に永続。サイクルをまたいで heat が蓄積・減衰する。
//
// 数式（1サイクル）:
//   1) 減衰: heat *= 0.5 ^ (経過h / HALF_LIFE_H)
//   2) 加点: heat += Σ weight(event,delta) × icpFactor(company)

const HALF_LIFE_H = parseFloat(process.env.MONITOR_HALF_LIFE_H || '72'); // 半減期（h）
const GONE_CONFIRM = parseInt(process.env.MONITOR_GONE_CONFIRM || '2', 10); // 連続不在が何サイクルで「確定不在」か（偽差分抑制）

// イベント重み。求人増は逓減（log2）で、1件増と10件増の差を圧縮しつつ向きは効かせる。
function eventWeight(event, delta) {
  switch (event) {
    case 'NEW': return 10;
    case 'NEW_GRAD_YEAR': return 8;
    case 'REAPPEARED': return 5;
    case 'JOB_UP': return 3 * Math.log2(1 + Math.max(0, delta));
    case 'NEW_QUERY': return 2;
    case 'JOB_DOWN': return -1;
    case 'GONE': return 0; // 加点せず減衰に任せる
    default: return 0;
  }
}

// ICP適合係数（発見段階では従業員数等が不明なので軽め）。
//  - 来期/再来期の卒年を含む＝設計期に入った＝アツい → ×1.3
//  - ICP職種一致（営業/エンジニア等）→ ×1.2
const ICP_JOB_RE = /営業|エンジニア|技術|企画|コンサル|マーケ|総合職/;
function icpFactor(company, { nextGradYears = [] } = {}) {
  if (!company) return 1;
  let f = 1;
  if ((company.gradYears || []).some((y) => nextGradYears.includes(y))) f *= 1.3;
  // ICP職種判定はスクレイプ職種名＋ヒットしたクエリ語の両方を見る。
  // 媒体ごとに職種抽出の粒度が違っても（例: リクナビは社名のみ取得）、
  // 「新卒 営業 東京」等のクエリで出た時点でその職種intentは確定するため、ソース間で公平になる。
  const srcs = Object.values(company.sources || {});
  const signals = srcs.flatMap((s) => (s.jobs || []).concat(s.queries || []));
  if (signals.some((t) => ICP_JOB_RE.test(t))) f *= 1.2;
  // 真の掲載鮮度（媒体が出す"新着/N日前/掲載日"由来）。新しい掲載ほど強く加点＝観測初回NEXTに頼らない本物の鮮度。
  f *= recencyFactor(company.recencyDays);
  return f;
}

// 掲載日数→鮮度係数。直近ほど高い。null（鮮度不明）は中立=1。
function recencyFactor(days) {
  if (days == null) return 1;
  if (days <= 1) return 1.5;
  if (days <= 3) return 1.3;
  if (days <= 7) return 1.15;
  if (days <= 14) return 1.05;
  return 1;
}

function hoursBetween(aIso, bIso) {
  const a = new Date(aIso).getTime(); const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / 3600000);
}

// 熱量状態を更新する（破壊的に state を書き換えて返す）。
//   state: { key: { 企業名, heat, lastEventTs, firstSeen, history[] } }
//   deltas: diffSnapshots の出力
//   curSnap: 今サイクルのスナップショット（icpFactor 算出に使用）
function applyCycle(state, deltas, curSnap, { now, nextGradYears = [], halfLifeH = HALF_LIFE_H } = {}) {
  now = now || new Date().toISOString();

  // 1) 全社を減衰（前回更新からの経過hで半減）
  for (const s of Object.values(state)) {
    const ageH = hoursBetween(s.lastEventTs || s.firstSeen || now, now);
    s.heat = (s.heat || 0) * Math.pow(0.5, ageH / halfLifeH);
    s.lastEventTs = now; // 次サイクルの基準（減衰の二重適用を防ぐ）
  }

  // 2) イベント加点
  for (const [key, d] of Object.entries(deltas)) {
    const wasKnown = !!state[key];
    let cur = curSnap && curSnap.companies ? curSnap.companies[key] : null;
    const company = cur || (d.cur || null);
    const f = icpFactor(company, { nextGradYears });

    // 偽差分抑制（多数決GONE）: 検索順位変動で1〜数サイクル消えてすぐ戻る"点滅"を REAPPEARED と誤計上しない。
    // 直前までの連続不在数(missStreak)が確定閾値(GONE_CONFIRM)以上だった社の復帰のみ REAPPEARED に昇格、
    // それ未満の点滅は「継続在籍」とみなしNEWを抑制（イベント無しなら加点せずスキップ）。
    const prevMiss = wasKnown ? (state[key].missStreak || 0) : 0;
    let events = d.events;
    if (wasKnown && events.some((e) => e.event === 'NEW')) {
      if (prevMiss >= GONE_CONFIRM) {
        events = events.map((e) => (e.event === 'NEW' ? { ...e, event: 'REAPPEARED' } : e));
      } else {
        events = events.filter((e) => e.event !== 'NEW'); // 点滅復帰: 復活イベントを抑制
      }
    }
    if (!events.length) continue; // 抑制の結果イベントが消えたら加点せずスキップ（点滅で熱量が動かない）

    let pts = 0;
    for (const e of events) pts += eventWeight(e.event, e.delta) * f;

    if (!state[key]) state[key] = { 企業名: d.企業名, heat: 0, firstSeen: now, lastEventTs: now, history: [] };
    const s = state[key];
    s.企業名 = d.企業名 || s.企業名;
    s.heat = Math.max(0, (s.heat || 0) + pts);
    s.lastEventTs = now;
    s.lastEvents = events.map((e) => e.event);
    s.totalJobs = company ? company.totalJobs : s.totalJobs;
    s.gradYears = company ? company.gradYears : s.gradYears;
    if (company && company.recencyDays != null) s.recencyDays = company.recencyDays;
    s.history.push({ ts: now, events: events.map((e) => ({ ...e })), points: Number(pts.toFixed(2)) });
    if (s.history.length > 50) s.history = s.history.slice(-50); // 履歴は直近50件
  }

  // 3) 在不在の更新（多数決GONEの土台）: 今サイクルのスナップショットに居れば missStreak=0、
  //    居なければ +1。次サイクルの REAPPEARED 判定に使う。
  const present = (curSnap && curSnap.companies) || {};
  for (const [key, s] of Object.entries(state)) {
    s.missStreak = present[key] ? 0 : (s.missStreak || 0) + 1;
  }
  return state;
}

// 熱い順ランキング（heat降順、同点は①掲載が新しい順②直近イベントが新しい順）。
// 真の掲載鮮度(recencyDays)をタイブレーク第一位に置くことで、全社NEXTで熱量同点でも
// "本当に新しく掲載した社"が上位に来る（観測初回NEXT≠真の新しさ問題の最終解消）。
function rank(state, { now, limit = 50, minHeat = 0.01 } = {}) {
  now = now || new Date().toISOString();
  const recOrInf = (s) => (s.recencyDays == null ? Infinity : s.recencyDays);
  return Object.entries(state)
    .map(([key, s]) => ({ key, ...s, freshnessH: hoursBetween(s.lastEventTs, now) }))
    .filter((s) => (s.heat || 0) >= minHeat)
    .sort((a, b) => (b.heat - a.heat) || (recOrInf(a) - recOrInf(b)) || (a.freshnessH - b.freshnessH))
    .slice(0, limit);
}

module.exports = { applyCycle, rank, eventWeight, icpFactor, recencyFactor, HALF_LIFE_H };
