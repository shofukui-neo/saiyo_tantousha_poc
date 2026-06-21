'use strict';
// 自律ブレイン（OpenClaw的な自走部）。クロール対象（クエリ）を自分で広げ／枯れたら畳み、
// セレクタ劣化を自己検知する。状態は store.js の queries.json に永続。
//
//  - クエリ自己増殖: NEW/熱を多産したクエリ → 近接クエリ（同職種×別エリア, 同エリア×別職種）を自動追加。
//  - 枯渇撤退:       連続 DRY_LIMIT サイクル新規ゼロのクエリは休止（礼儀＝無駄打ちを減らす）。
//  - セレクタ自己修復: あるソースが全クエリ0件＝DOM変更の疑い。GEMINI_KEY があればHTML較正を試みる(任意)。
const { loadQueryState, saveQueryState } = require('./store');

const JOBS = ['営業', 'エンジニア', '企画', '総合職', 'マーケティング', 'コンサル', '事務', '販売'];
const AREAS = ['東京', '大阪', '名古屋', '福岡', '横浜', '札幌', '仙台'];
const PREFIX = '新卒';

const MAX_ACTIVE = parseInt(process.env.MONITOR_MAX_QUERIES || '12', 10); // 1サイクルの最大クエリ数（礼儀＝負荷上限）
const DRY_LIMIT = parseInt(process.env.MONITOR_DRY_LIMIT || '3', 10);     // 連続新規ゼロで休止
const SEED = (process.env.MONITOR_SEED_QUERIES || '新卒 営業 東京;新卒 エンジニア 東京;新卒 営業 大阪')
  .split(/[;；]/).map((s) => s.trim()).filter(Boolean);

function qParts(q) {
  // "新卒 営業 東京" → {job:'営業', area:'東京'}
  const toks = q.replace(PREFIX, '').trim().split(/\s+/).filter(Boolean);
  const area = toks.find((t) => AREAS.includes(t)) || '';
  const job = toks.find((t) => JOBS.includes(t)) || '';
  return { job, area };
}
function mkQ(job, area) { return [PREFIX, job, area].filter(Boolean).join(' '); }

// 近接クエリ生成: 同職種×別エリア + 同エリア×別職種
function neighbors(q) {
  const { job, area } = qParts(q);
  const out = new Set();
  if (job) for (const a of AREAS) out.add(mkQ(job, a));
  if (area) for (const j of JOBS) out.add(mkQ(j, area));
  out.delete(q);
  return [...out];
}

function initState() {
  const st = { queries: {}, cycle: 0 };
  for (const q of SEED) st.queries[q] = { dry: 0, active: true, born: 'seed', hits: 0 };
  return st;
}

// 今サイクルで叩くべきアクティブなクエリ集合を返す。
function activeQueries(state) {
  return Object.entries(state.queries).filter(([, v]) => v.active).map(([q]) => q).slice(0, MAX_ACTIVE);
}

// サイクル結果を反映してクエリ集合を更新（増殖／撤退）。
//   perQueryNew: { [query]: 新規(NEW/REAPPEARED)社数 }  ← run.js が diff から集計して渡す
//   staleSources: 0件ソース名（ログ用）
function evolve(state, { perQueryNew = {}, staleSources = [] } = {}) {
  state.cycle = (state.cycle || 0) + 1;
  const added = [];
  const retired = [];
  for (const [q, v] of Object.entries(state.queries)) {
    if (!v.active) continue;
    const fresh = perQueryNew[q] || 0;
    v.hits = (v.hits || 0) + fresh;
    if (fresh > 0) {
      v.dry = 0;
      // 多産クエリは近接クエリを増殖（枠が空いていれば）
      if (fresh >= 2) {
        for (const nb of neighbors(q)) {
          if (Object.keys(state.queries).length >= 64) break; // 暴走バックストップ
          if (!state.queries[nb]) { state.queries[nb] = { dry: 0, active: false, born: `from:${q}`, hits: 0 }; added.push(nb); }
        }
      }
    } else {
      v.dry = (v.dry || 0) + 1;
      if (v.dry >= DRY_LIMIT) { v.active = false; retired.push(q); }
    }
  }
  // アクティブ枠に空きがあれば、休止中(=増殖した未試行)クエリを hits 期待で起こす
  const activeCount = Object.values(state.queries).filter((v) => v.active).length;
  if (activeCount < MAX_ACTIVE) {
    const dormant = Object.entries(state.queries)
      .filter(([, v]) => !v.active && v.dry < DRY_LIMIT)
      .sort((a, b) => (b[1].hits || 0) - (a[1].hits || 0));
    for (const [q, v] of dormant.slice(0, MAX_ACTIVE - activeCount)) { v.active = true; v.dry = 0; }
  }
  state.staleSources = staleSources;
  return { added, retired };
}

// run.js から使う高レベルAPI: 状態を読み（無ければ初期化）、アクティブクエリを返す。
function loadOrInit() { return loadQueryState() || initState(); }

module.exports = { loadOrInit, activeQueries, evolve, neighbors, saveQueryState, initState, SEED, MAX_ACTIVE };
