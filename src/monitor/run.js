'use strict';
// モニタリング・オーケストレータ。1サイクル = ①観測→②保存→③差分→④熱量→⑤出力 + 自律ブレイン更新。
// 状態はすべてディスク永続なので、--once を cron/タスクスケジューラで定期起動しても、
// --watch で常駐しても、中断・再開して継続できる。
//
//   node src/monitor/run.js --once                  1サイクルだけ
//   node src/monitor/run.js --watch --interval 60   60分毎に常時監視（フォアグラウンド常駐）
//   オプション: --pages N（1クエリの巡回ページ数, 既定1） --top N（出力件数, 既定30）
const { captureSnapshot } = require('./snapshot');
const { diffSnapshots } = require('./diff');
const { applyCycle, rank } = require('./heat');
const { writeReports } = require('./report');
const {
  saveSnapshot, loadLastSnapshot, loadHeatState, saveHeatState, saveQueryState,
} = require('./store');
const autonomy = require('./autonomy');
const { closeBrowser } = require('../fetch');

function getArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
const PAGES = parseInt(getArg('pages', '1'), 10) || 1;
const TOP = parseInt(getArg('top', '30'), 10) || 30;
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

// 今期/来期の卒年（ICP係数の「設計期に入った」判定用）。今日基準で粗く推定。
function nextGradYears() {
  const y = new Date().getFullYear();
  // 6月以降は翌々年卒の設計が本格化するので来期＋再来期を「アツい」とみなす
  return [String(y + 1), String(y + 2)];
}

async function runCycle() {
  const cycle = new Date().toISOString();
  const qstate = autonomy.loadOrInit();
  const queries = autonomy.activeQueries(qstate);
  log(`サイクル開始: ${queries.length}クエリ × ${PAGES}ページ`);
  log(`  クエリ: ${queries.join(' / ')}`);

  // ① 観測
  const snap = await captureSnapshot(queries, { cycle, maxPagesPerQuery: PAGES, onWarn: (m) => log('  ⚠ ' + m) });
  const obs = Object.keys(snap.companies).length;
  log(`  観測: ${obs}社`);

  // ② 直前を読み → ③ 差分
  const prev = loadLastSnapshot();
  const deltas = diffSnapshots(prev, snap);
  const newCnt = Object.values(deltas).filter((d) => d.events.some((e) => e.event === 'NEW')).length;
  log(`  差分: ${Object.keys(deltas).length}社に変化（うち初出 ${newCnt}）`);

  // ④ 熱量更新（減衰＋加点）→ 永続
  const state = applyCycle(loadHeatState(), deltas, snap, { now: cycle, nextGradYears: nextGradYears() });
  saveHeatState(state);
  saveSnapshot(snap); // 差分計算後に「今回」を直前として保存

  // ⑤ 出力
  const ranked = rank(state, { now: cycle, limit: Math.max(TOP, 50) });
  const rep = writeReports(ranked, { cycle, stats: snap.stats, top: TOP });
  log(`  出力: ${rep.count}社 → ${rep.mdPath}`);
  if (ranked.length) {
    const top5 = ranked.slice(0, 5).map((s, i) => `${i + 1}.${s.企業名}(${s.heat.toFixed(1)})`).join('  ');
    log(`  🔥 TOP5: ${top5}`);
  }

  // ⑤' スプシ自動保存（設定があれば時系列で追記。失敗しても監視は止めない）
  try {
    const sink = require('./sheets-sink');
    const res = await sink.appendHottest(ranked.slice(0, TOP), { cycle, snap });
    if (res.appended) log(`  📊 スプシ追記: ${res.appended}行 → タブ「${res.tab}」`);
    else if (res.skipped) log('  📊 スプシ未設定（MONITOR_SHEET_ID/認証）→スキップ');
  } catch (e) { log('  ⚠ スプシ書込失敗: ' + String(e && e.message || e).slice(0, 100)); }

  // 自律ブレイン: クエリ別の新規数を集計して増殖/撤退を判断
  const perQueryNew = {};
  for (const d of Object.values(deltas)) {
    if (!d.events.some((e) => ['NEW', 'REAPPEARED'].includes(e.event))) continue;
    const qs = new Set();
    for (const s of Object.values((d.cur && d.cur.sources) || {})) for (const q of s.queries || []) qs.add(q);
    for (const q of qs) perQueryNew[q] = (perQueryNew[q] || 0) + 1;
  }
  const evo = autonomy.evolve(qstate, { perQueryNew, staleSources: snap.stats.staleSources });
  saveQueryState(qstate);
  if (evo.added.length) log(`  🧠 クエリ増殖: +${evo.added.length}（例 ${evo.added.slice(0, 3).join(', ')}）`);
  if (evo.retired.length) log(`  🧠 クエリ撤退: ${evo.retired.join(', ')}`);
  if (snap.stats.staleSources.length) log(`  🛠 要セレクタ較正: ${snap.stats.staleSources.join(', ')}（GEMINI_KEYで自己修復可）`);

  return { cycle, observed: obs, changed: Object.keys(deltas).length, hottest: ranked.slice(0, TOP) };
}

(async () => {
  const watch = process.argv.includes('--watch');
  const intervalMin = parseInt(getArg('interval', '60'), 10) || 60;
  // real-time成立のため、監視キャッシュTTLをサイクル間隔の半分に自動設定（未指定時）。
  // これで同一クエリでも毎サイクル再取得され、差分=変化が検知できる（Blocker①対策）。
  if (!process.env.MONITOR_CACHE_TTL_MS) {
    process.env.MONITOR_CACHE_TTL_MS = String(Math.max(60000, Math.floor(intervalMin * 60 * 1000 / 2)));
  }
  try {
    if (!watch) {
      await runCycle();
    } else {
      log(`常時監視モード: ${intervalMin}分間隔`);
      // 最初の1回を即実行し、以降は interval 毎。各サイクルは独立に try/catch（1回コケても継続）。
      const tick = async () => { try { await runCycle(); } catch (e) { log('サイクル失敗: ' + (e && e.message || e)); } };
      await tick();
      setInterval(tick, intervalMin * 60 * 1000);
      await new Promise(() => {}); // 常駐
    }
  } catch (e) {
    console.error('FATAL', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    if (!watch) await closeBrowser().catch(() => {});
  }
})();
