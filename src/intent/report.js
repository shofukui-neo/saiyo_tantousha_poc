'use strict';
/**
 * 層2の成果物レポート（data/intent-*.md）の生成
 * ============================================================================
 * intent-analyze.js（取得して採点）と rescore-intent.js（採点だけやり直す）の
 * 両方から同じ形のレポートを出すために切り出した層。
 *
 * 切り出した理由: 閾値を引き直した後に採点だけやり直すと、CSVの階層は直るのに
 * レポートの階層件数だけが前の値のまま残る。成果物の中で数字が食い違うのが一番まずい。
 */
const path = require('path');

/**
 * @param {Array} rows 出力行（総合優先度の降順）
 * @param {object} stats { 処理, 検知, 資料あり, A, B, C, D, signals }
 * @param {object} opts { signalList, tiers, topWeight, 入力, 系統, top, root }
 */
function buildReport(rows, stats, opts = {}) {
  const { signalList = [], tiers = [], topWeight = 0, 入力 = '', 系統 = '', top: TOP = 80 } = opts;
  const top = rows.slice(0, TOP);
  // 全行の集計は stats 優先。レポートは上位N社しか受け取らない場合があり、
  // rows から数えるとそのN社ぶんの数字になってしまう（全体の件数として出すと嘘になる）。
  const cnt = (k) => (stats.適合内訳 && stats.適合内訳[k] != null)
    ? stats.適合内訳[k] : rows.filter((r) => r.MOCHCA適合判定 === k).length;
  const L = [];
  L.push('# いま刺すべき企業（層2: タイミングシグナル）');
  L.push('');
  L.push(`- 生成: ${new Date().toISOString()}`);
  L.push(`- 入力: ${入力} ／ 取得系統: ${系統} ／ 処理 ${stats.処理}社`);
  L.push(`- シグナル検知: ${stats.検知}社（A:${stats.A || 0} B:${stats.B || 0} C:${stats.C || 0} D:${stats.D || 0}）`);
  L.push(`- 分析軸: ${signalList.length}種類。総合優先度は適合ゲート付きの営業仮説であり、受注確率ではありません。`);
  L.push(`- 出力内の適合: ${cnt('適合')}社／要確認: ${cnt('要確認')}社／対象外: ${cnt('対象外')}社`);
  L.push(`- 根拠資料あり: ${stats.資料あり || 0}社。資料がない企業は未検知であり、課題がないことを意味しません。`);
  // 階層の意味は閾値で決まる。軸を足すと合計点の目盛りが伸びるので、閾値は都度引き直している。
  // その事実を成果物側にも書いておかないと、過去の回と件数を比べた時に誤読される。
  if (tiers.length) {
    L.push(`- 階層の閾値: ${tiers.map((t) => `${t.tier}≥${t.min}`).join(' / ')}`
      + `（A は${signalList.length}軸の実測分布で上位約10%になるよう較正。最上位の重み${topWeight}の軸が「確定」なら単独でA）`);
  }
  const 卒年面あり = stats.卒年面あり != null
    ? stats.卒年面あり : rows.filter((r) => String(r['卒年面'] || '').includes('+')).length;
  if (卒年面あり) L.push(`- 2卒年ぶんの掲載面が取れた企業: ${卒年面あり}社（募集人数の前年比・次年度面の始動はこの社でのみ判定）`);
  L.push('- 使用範囲: 入力CSVと指定した取得系統のみ。公開記載を評価し、市場全体の網羅性や受注率向上は未検証です。');
  L.push('');
  L.push('## シグナル別の検知数');
  L.push('');
  L.push('| # | シグナル | 重み | 検知社数 | 備考 |');
  L.push('|---|---|---|---|---|');
  for (const s of signalList) {
    L.push(`| ${s.順位} | ${s.名称} | ${s.weight} | ${stats.signals[s.id] || 0} | ${s.要履歴 ? '“新設”は履歴が要る（初回は保有止まり）' : s.説明} |`);
  }
  L.push('');
  L.push(`## 上位${top.length}社`);
  L.push('');
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    L.push(`### ${i + 1}. ${r['企業名']}　［${r['インテント階層']}／${r['インテントスコア']}点］`);
    L.push(`- 電話: ${r['電話番号'] || '—'}　宛名: ${r['採用担当者名'] || r['架電宛名']}　従業員: ${r['従業員数'] || '—'}名　業種: ${r['業種'] || '—'}`);
    L.push(`- なぜ今: ${r['なぜ今']}`);
    L.push(`- MOCHCA適合: ${r.MOCHCA適合判定}／総合優先度:${r.総合優先度}／${r.MOCHCA適合根拠}`);
    L.push(`- 次の対応: ${r.推奨アクション}／${r.提案ルート}／要確認:${r.要確認項目 || 'なし'}`);
    L.push(`- 根拠: ${r['根拠']}`);
    if (r.根拠URL一覧) L.push(`- 根拠URL: ${r.根拠URL一覧}`);
    if (r['推奨トーク']) L.push(`- トーク: ${r['推奨トーク']}`);
    L.push('');
  }
  return L.join('\n');
}

// 採点済みCSVから、レポートに要る統計を数え直す（採点し直し用）
function statsFromRows(rows, signalList = []) {
  const stats = { 処理: rows.length, 検知: 0, 資料あり: 0, A: 0, B: 0, C: 0, D: 0, signals: {} };
  const byCol = new Map(signalList.map((s) => [s.列, s.id]));
  for (const r of rows) {
    if (String(r['検知シグナル'] || '').trim()) stats.検知++;
    if (String(r['インテント資料JSON'] || '[]').length > 2) stats.資料あり++;
    const t = r['インテント階層'];
    if (t) stats[t] = (stats[t] || 0) + 1;
    for (const [col, id] of byCol) if (String(r[col] || '').trim()) stats.signals[id] = (stats.signals[id] || 0) + 1;
  }
  return stats;
}

module.exports = { buildReport, statsFromRows };
