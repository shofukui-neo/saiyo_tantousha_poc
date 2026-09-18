'use strict';
/**
 * 全社 ICP適合 × インテント × 総合優先度（層1と層2の閉じ込み）
 * ============================================================================
 * intent-analyze.js（30シグナル版）を統合マスタ全社に当てた結果を受け取り、
 * 掲載面で充填された一次情報で ICP v5.1 を採点し直してから総合優先度を出し直す。
 *
 * なぜ採点し直すのか:
 *   intent-analyze の 総合優先度 は、入力CSVが持っていた「アポ期待度」を層1として使う。
 *   ところが v5 の第2段は **年間新卒採用人数が唯一の軸**で、統合マスタではこの列が
 *   ほぼ空だった（＝全社が「不明 ×0.93」で横並び）。走らせた結果、その人数は
 *   掲載面（卒年面の募集人数・定着率開示欄の入社実数）から実際に埋まっている。
 *   ＝ここで採点し直すと、第2段が初めて効く。
 *
 *   総合優先度 = (インテントスコア × 0.65 + ICPスコア × 0.35) × 予算係数
 *                ただし MOCHCA適合判定が 対象外→0 ／ 要確認→49で頭打ち
 *   （係数・頭打ちは intent/target-fit.js と同一。定義を二重に持たない）
 *
 * 使い方:
 *   node src/build-icp-intent-all.js
 *   node src/build-icp-intent-all.js --in data/leads-intent-wide.csv --min 50
 */
const fs = require('fs');
const path = require('path');
const { readCsv, toCsv } = require('./csv');
const { scoreMochica } = require('./mochica-fit');

const ROOT = path.resolve(__dirname, '..');
const getArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

const IN = path.resolve(ROOT, getArg('in', 'data/leads-intent-wide.csv'));
const OUT = path.resolve(ROOT, getArg('out', 'data/leads-icp-intent-all.csv'));
const CALL = path.resolve(ROOT, getArg('call', 'data/leads-icp-intent-call.csv'));
const REPORT = path.resolve(ROOT, getArg('report', 'data/icp-intent-all.md'));
const MIN = parseFloat(getArg('min', '0'));
const CALL_MIN = parseFloat(getArg('call-min', '50'));

const g = (r, k) => String(r && r[k] != null ? r[k] : '').trim();

// 「36～40名(28卒面の募集人数)」「11～15名」「26名」→ 下限。範囲は下限で取る（過大評価しない）。
function lowerBound(s) {
  const m = String(s || '').normalize('NFKC').replace(/,/g, '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function num(s) {
  const t = String(s || '').normalize('NFKC').trim().replace(/,/g, '');
  return /^\d+\s*(?:名|人)?$/.test(t) ? parseInt(t, 10) : null;
}

// 総合ランク。70/50 は MOCHICA_PRIORITY_HIGH/_MID と同じ帯（運用の意味を動かさない）。
// 要確認は49で頭打ちなので、S/A/B は実質「適合が確認できた社」だけが入る。
function rankOf(p, status) {
  if (status === '対象外' || p <= 0) return '除外';
  if (p >= 70) return 'S';
  if (p >= 60) return 'A';
  if (p >= 50) return 'B';
  return 'C';
}

function main() {
  if (!fs.existsSync(IN)) { console.error('入力が無い: ' + IN); process.exit(1); }
  const { headers, records } = readCsv(fs.readFileSync(IN, 'utf8'));
  log('読み込み ' + records.length + '社 ← ' + path.relative(ROOT, IN));

  let filled = 0;
  for (const rec of records) {
    // 掲載面で埋まった一次情報を ICP の入力に戻す（target-fit の resolveIcpInputs と同じ優先順）
    const emp = num(rec['従業員数']) != null ? num(rec['従業員数'])
      : num(g(rec, '従業員数(掲載)').replace(/名$/, ''));
    let hire = num(rec['年間新卒採用人数']);
    if (hire == null) hire = lowerBound(g(rec, '新卒規模'));
    if (hire == null) hire = lowerBound(g(rec, '募集人数(最新卒年)'));
    if (hire == null) hire = lowerBound(g(rec, '昨年度入社数').replace(/^\d{4}年/, ''));
    if (hire == null) hire = num(rec['採用予定人数']);
    if (num(rec['年間新卒採用人数']) == null && hire != null) filled++;

    const s = scoreMochica(Object.assign({}, rec, {
      従業員数: emp != null ? emp : '',
      年間新卒採用人数: hire != null ? hire : '',
      採用構成: g(rec, '採用構成'),
    }));

    const status = g(rec, 'MOCHCA適合判定') || '要確認';
    const intent = parseFloat(rec['インテントスコア']) || 0;
    const budget = Math.max(0.5, Math.min(1, parseFloat(rec['予算係数']) || 1));
    const raw = (intent * 0.65 + s.total * 0.35) * budget;
    const prio = status === '対象外' ? 0
      : Math.round(Math.min(status === '要確認' ? 49 : 100, raw) * 10) / 10;

    rec['ICPスコア(充填後)'] = String(s.total);
    rec['ICP帯'] = s.priority;
    rec['ICP組織型'] = s.orgLabel;
    rec['ICP確信度'] = String(s.confidence);
    rec['ICP根拠(v5.1)'] = s.reasons.filter((r) => r.indexOf('V5:') === 0 || r.indexOf('NEG:') === 0).join('／');
    rec['ICP入力(充填後)'] = '従業員:' + (emp != null ? emp : '不明') + '／新卒:' + (hire != null ? hire : '不明');
    rec['アポ期待度'] = String(s.total);       // 層1の現行値に揃える
    rec['総合優先度'] = String(prio);
    rec['総合ランク'] = rankOf(prio, status);
    rec['決め手'] = [
      g(rec, '最有力シグナル') ? '層2:' + g(rec, '最有力シグナル') : '',
      '層1:' + s.orgLabel + '／従業員' + (emp != null ? emp : '不明') + '／新卒' + (hire != null ? hire : '不明') + '名',
      g(rec, '予算状態') ? '予算:' + g(rec, '予算状態') : '',
    ].filter(Boolean).join('｜');
  }

  const cols = headers.slice();
  const ADD = ['ICPスコア(充填後)', 'ICP帯', 'ICP組織型', 'ICP確信度', 'ICP根拠(v5.1)', 'ICP入力(充填後)', '総合ランク', '決め手'];
  for (const c of ADD) if (cols.indexOf(c) < 0) cols.push(c);

  // 並べ替えの主キーは総合優先度。同点は層2→層1の順で割る。
  records.sort((a, b) => (parseFloat(b['総合優先度']) || 0) - (parseFloat(a['総合優先度']) || 0)
    || (parseFloat(b['インテントスコア']) || 0) - (parseFloat(a['インテントスコア']) || 0)
    || (parseFloat(b['ICPスコア(充填後)']) || 0) - (parseFloat(a['ICPスコア(充填後)']) || 0));
  records.forEach((r, i) => { r.No = String(i + 1); });

  const kept = records.filter((r) => (parseFloat(r['総合優先度']) || 0) >= MIN);
  fs.writeFileSync(OUT, toCsv(cols, kept), 'utf8');
  log('出力(詳細): ' + path.relative(ROOT, OUT) + ' ' + kept.length + '社');

  // 架電用の短い版。営業がそのまま読む列だけ。
  const CALL_COLS = ['No', '総合優先度', '総合ランク', '企業名', '架電宛名', '採用担当者名', '電話番号', '業種', '従業員数',
    '本社', 'ICPスコア(充填後)', 'ICP組織型', 'インテントスコア', 'インテント階層', '最有力シグナル', 'なぜ今',
    '推奨アクション', '推奨トーク', '募集人数(最新卒年)', '昨年度入社数', '予算状態', 'MOCHCA適合判定', '要確認項目', '採用ページURL'];
  const call = records.filter((r) => (parseFloat(r['総合優先度']) || 0) >= CALL_MIN && g(r, '電話番号'));
  fs.writeFileSync(CALL, toCsv(CALL_COLS, call), 'utf8');
  log('出力(架電): ' + path.relative(ROOT, CALL) + ' ' + call.length + '社（総合' + CALL_MIN + '以上かつ電話番号あり）');

  // ── レポート ──
  const byRank = {}; const byStatus = {}; const byTier = {};
  for (const r of records) {
    byRank[r['総合ランク']] = (byRank[r['総合ランク']] || 0) + 1;
    const st = g(r, 'MOCHCA適合判定') || '(空)';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const t = g(r, 'インテント階層') || '-';
    byTier[t] = (byTier[t] || 0) + 1;
  }
  const L = [];
  L.push('# 全社 ICP適合 × インテント × 総合優先度', '');
  L.push('生成: ' + new Date().toISOString().slice(0, 10) + '／母集団 ' + records.length + '社（統合マスタのうち採点可能な社）', '');
  L.push('## 総合優先度の定義', '');
  L.push('```', '総合優先度 = (インテントスコア × 0.65 + ICPスコア × 0.35) × 予算係数',
    '  MOCHCA適合判定: 対象外 → 0 ／ 要確認 → 49で頭打ち ／ 適合 → 100まで', '```', '');
  L.push('ICPスコアは v5.1（2段の期待値モデル）を **掲載面で充填した従業員数・新卒採用人数で採点し直した値**。', '');
  L.push('## 総合ランク別', '', '| ランク | 社数 |', '|---|---|');
  const RANK_LABEL = { S: 'S(70+)', A: 'A(60-69)', B: 'B(50-59)', C: 'C(-49)', 除外: '除外' };
  for (const k of ['S', 'A', 'B', 'C', '除外']) L.push('| ' + RANK_LABEL[k] + ' | ' + (byRank[k] || 0) + ' |');
  L.push('', '## MOCHICA適合判定別', '', '| 判定 | 社数 |', '|---|---|');
  for (const kv of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) L.push('| ' + kv[0] + ' | ' + kv[1] + ' |');
  L.push('', '## インテント階層別', '', '| 階層 | 社数 |', '|---|---|');
  for (const k of Object.keys(byTier).sort()) L.push('| ' + k + ' | ' + byTier[k] + ' |');
  L.push('', '## 上位50社', '');
  L.push('| # | 総合 | ランク | 企業名 | ICP | インテント | 最有力シグナル | 判定 |', '|---|---|---|---|---|---|---|---|');
  for (const r of records.slice(0, 50)) {
    L.push('| ' + r.No + ' | ' + r['総合優先度'] + ' | ' + r['総合ランク'] + ' | ' + g(r, '企業名')
      + ' | ' + r['ICPスコア(充填後)'] + ' | ' + g(r, 'インテントスコア') + ' | ' + g(r, '最有力シグナル')
      + ' | ' + g(r, 'MOCHCA適合判定') + ' |');
  }
  L.push('', '## 注意', '');
  L.push('- 総合優先度は **受注確率ではなく架電の並び順**。学習済みの受注モデルではない。');
  L.push('- 採用構成（S30・中途中心ゲート）は `midjobs` 系統を回していないため大半が「不明」＝落としていない。');
  L.push('- 「要確認」は49で頭打ち。業種・従業員数・新卒人数のいずれかが埋まれば上に出る。');
  fs.writeFileSync(REPORT, L.join('\n'), 'utf8');
  log('レポート: ' + path.relative(ROOT, REPORT));
  log('新卒採用人数が掲載面で埋まった社: ' + filled + '社');
}
main();
