'use strict';
/**
 * telapo-analyze — 架電の単一分析＋台帳集計（ダッシュボード）
 * =====================================================================
 * 規則辞書は talk-analysis.js を共用（＝BALES後追い分析と同一ロジック）。
 * 依存なし・完全ローカル。
 *
 * ■ 単一架電の分析（運用画面のライブ判定）
 *     analyzeCall({ result, transcript, memo, pending })
 *       → { resultClass, refusalReason, talkElements, talkSamples }
 *
 * ■ 台帳の集計（分析ダッシュボード）
 *     aggregate(calls) → 接続ファネル/結果分布/断り理由/トーク要素/語彙lift/
 *                        オペレーター別/日次
 *
 * ■ CLI（台帳を集計して標準出力へ。--json でJSON出力）
 *     node src/telapo-analyze.js
 */
const TA = require('./talk-analysis');

const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '-');

// 断り理由/トーク/lift 判定に使うテキスト（文字起こし＋メモを連結）
function callText(rec) {
  return [rec && rec.transcript, rec && rec.memo].filter(Boolean).join(' 　 ');
}

/**
 * 単一架電のライブ分析。結果種別・断り理由（お断り時）・トーク要素を規則で判定。
 * @param {{result?:string, transcript?:string, memo?:string, pending?:string}} input
 */
function analyzeCall(input = {}) {
  const resultClass = TA.classifyResult(input.result);
  const text = callText(input);
  const { elements } = TA.classifyTalk(text);
  // 断り理由はお断り時に意味を持つが、示唆として常時算出（UI側で結果に応じ提示）。
  const refusalReason = TA.classifyRefusal({ comment: text, pending: input.pending });
  return {
    resultClass,
    suggestedResult: TA.suggestResult(text), // 文字起こしからの結果自動推定（プルダウン初期値）
    refusalReason,
    talkElements: elements.map((e) => e.label),
    talkSamples: elements, // {label, sample}
  };
}

// 分布集計ヘルパ（値→件数、降順配列）
function dist(items) {
  const m = new Map();
  for (const v of items) { const k = v || '(未設定)'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * 台帳（架電レコード配列）を集計してダッシュボード用の統計を返す。
 */
function aggregate(calls) {
  const rows = Array.isArray(calls) ? calls : [];
  const funnel = rows.map((r) => ({ r, c: TA.classifyResult(r.result) }));

  const total = rows.length;
  const reached = funnel.filter((x) => x.c.reached);
  const appo = funnel.filter((x) => x.c.appo);
  const refused = funnel.filter((x) => x.c.refused);
  const follow = funnel.filter((x) => x.c.follow);

  // 結果分布
  const resultDist = dist(rows.map((r) => r.result)).map(([result, count]) => ({
    result, count, pct: pct(count, total),
  }));

  // 断り理由分布（保存済み refusalReason 優先・無ければテキストから分類）
  const refusalReasons = refused.map(({ r }) =>
    r.refusalReason || TA.classifyRefusal({ comment: callText(r), pending: r.pending }));
  const refusalDist = dist(refusalReasons).map(([reason, count]) => ({
    reason, count, pct: pct(count, refused.length),
  }));

  // アポ獲得トーク要素の出現率（保存済み talkElements 優先・無ければ分類）
  const talkCounts = new Map();
  for (const { r } of appo) {
    const labels = (Array.isArray(r.talkElements) && r.talkElements.length)
      ? r.talkElements
      : TA.classifyTalk(callText(r)).labels;
    for (const l of new Set(labels)) talkCounts.set(l, (talkCounts.get(l) || 0) + 1);
  }
  const talkDist = [...talkCounts.entries()].sort((a, b) => b[1] - a[1])
    .map(([element, count]) => ({ element, count, pct: pct(count, appo.length) }));

  // 語彙lift（アポ vs お断り の文字起こし語彙差）
  const lift = TA.computeLift(appo.map(({ r }) => callText(r)), refused.map(({ r }) => callText(r)))
    .map((x) => ({
      word: x.word,
      appoRate: +(100 * x.appoRate).toFixed(1),
      refuseRate: +(100 * x.refuseRate).toFixed(1),
      lift: x.lift === Infinity ? null : +x.lift.toFixed(2),
    }));

  // オペレーター別成績
  const opMap = new Map();
  for (const { r, c } of funnel) {
    const key = r.operator || '(未設定)';
    const o = opMap.get(key) || { operator: key, calls: 0, reached: 0, appo: 0 };
    o.calls++; if (c.reached) o.reached++; if (c.appo) o.appo++;
    opMap.set(key, o);
  }
  const operators = [...opMap.values()].map((o) => ({
    ...o,
    reachRate: pct(o.reached, o.calls),
    appoRate: pct(o.appo, o.calls),
    appoPerReached: pct(o.appo, o.reached),
  })).sort((a, b) => b.calls - a.calls);

  // 日次（記録時刻ベース）
  const dayMap = new Map();
  for (const { r, c } of funnel) {
    const d = String(r.ts || '').slice(0, 10) || '(不明)';
    const o = dayMap.get(d) || { date: d, calls: 0, reached: 0, appo: 0 };
    o.calls++; if (c.reached) o.reached++; if (c.appo) o.appo++;
    dayMap.set(d, o);
  }
  const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    summary: {
      total,
      reached: reached.length,
      reachRate: pct(reached.length, total),
      appo: appo.length,
      refused: refused.length,
      follow: follow.length,
      appoOfReached: pct(appo.length, reached.length),
      refusedOfReached: pct(refused.length, reached.length),
      followOfReached: pct(follow.length, reached.length),
    },
    resultDist,
    refusalDist,
    talkDist,
    lift,
    operators,
    daily,
  };
}

// ── CLI：台帳を集計して標準出力へ ──
function printDashboard(agg) {
  const s = agg.summary;
  console.log('════════════════════════════════════════════════════════════');
  console.log('  テレアポ分析ダッシュボード（架電台帳集計）');
  console.log('════════════════════════════════════════════════════════════');
  console.log('\n■ 接続ファネル');
  console.log('  総架電数        :', s.total, '件');
  console.log('  担当者接続      :', s.reached, `件（接続率 ${s.reachRate}）`);
  console.log('   ├ アポ獲得     :', s.appo, `件（接続後 ${s.appoOfReached}）`);
  console.log('   ├ 営業フォロー :', s.follow, `件（接続後 ${s.followOfReached}）`);
  console.log('   └ お断り       :', s.refused, `件（接続後 ${s.refusedOfReached}）`);

  console.log('\n■ コール結果分布');
  for (const r of agg.resultDist) console.log('   ' + String(r.count).padStart(5) + '  ' + r.pct.padStart(6) + '  ' + r.result);

  if (agg.refusalDist.length) {
    console.log('\n■ 断り理由（お断り ' + s.refused + '件）');
    for (const r of agg.refusalDist) console.log('   ' + String(r.count).padStart(5) + '  ' + r.pct.padStart(6) + '  ' + r.reason);
  }
  if (agg.talkDist.length) {
    console.log('\n■ アポ獲得トーク要素の出現率（アポ ' + s.appo + '件・複数該当可）');
    for (const r of agg.talkDist) console.log('   ' + String(r.count).padStart(5) + '  ' + r.pct.padStart(6) + '  ' + r.element);
  }
  if (agg.operators.length) {
    console.log('\n■ オペレーター別成績');
    console.log('   ' + '架電'.padStart(4) + ' ' + '接続率'.padStart(6) + ' ' + 'アポ率'.padStart(6) + '  担当');
    for (const o of agg.operators) {
      console.log('   ' + String(o.calls).padStart(4) + ' ' + o.reachRate.padStart(6) + ' ' + o.appoRate.padStart(6) + '  ' + o.operator);
    }
  }
  console.log('');
}

if (require.main === module) {
  const store = require('./telapo-store');
  const calls = store.readCalls();
  const agg = aggregate(calls);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(agg, null, 2));
  } else {
    printDashboard(agg);
    if (!calls.length) console.log('（台帳が空です。`npm run telapo` で運用画面を起動し架電を記録してください）\n');
  }
}

module.exports = { analyzeCall, aggregate, callText };
