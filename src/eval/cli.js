'use strict';
// ============================================================================
//  精度評価CLI — 実行 / ベースライン固定 / 回帰ゲート / ダッシュボード生成
// ----------------------------------------------------------------------------
//  使い方:
//    node src/eval/cli.js run            # 評価して指標を表示（eval/latest.json と履歴に記録）
//    node src/eval/cli.js baseline       # 現状を「基準」として凍結（eval/baseline.json）
//    node src/eval/cli.js gate           # 基準と比較し、精度が下がっていたら exit 1（回帰ゲート）
//    node src/eval/cli.js dashboard      # 履歴から eval/dashboard.html を再生成
//  オプション:
//    --names-limit N   氏名トラックで走査するページ数（既定1500・0で全件）
//    --icp-limit N     ICPトラックで採点するレコード数（既定0=全件）
//    --label "..."     履歴に残すラベル（例: refactor前 / B-1適用後）
//
//  「精度を落とさない」判定（gate）:
//    - ICP: 全レコードのスコアが基準と完全一致（1件でも動いたら退行＝fail）
//    - 氏名: ゴミ率↑・抽出率↓・有効名→無効化(per-item) が許容超なら fail
// ============================================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { evaluate } = require('./evaluate');
const { buildHtml } = require('./dashboard');

const ROOT = path.resolve(__dirname, '..', '..');
const EVAL_DIR = path.join(ROOT, 'eval');
const BASELINE = path.join(EVAL_DIR, 'baseline.json');
const LATEST = path.join(EVAL_DIR, 'latest.json');
const HISTORY = path.join(EVAL_DIR, 'history.jsonl');
const DASHBOARD = path.join(EVAL_DIR, 'dashboard.html');

// 退行とみなす許容差（パーセンテージポイント）。0=一切の悪化を許さない。
const TOL = { extractionRate: 0.5, dictFullRate: 0.5, garbageRate: 0.0 };

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) { const v = process.argv[i + 1]; return (v && !v.startsWith('--')) ? v : true; }
  return def;
}
function ensureDir() { if (!fs.existsSync(EVAL_DIR)) fs.mkdirSync(EVAL_DIR, { recursive: true }); }
function gitSha() {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (_) { return ''; }
}
function nowIso() { return new Date().toISOString(); }

// per-item を含まない「要約」（履歴・ダッシュボード用。軽量）。
function summarize(report) {
  const w = report.tracks.wantedly, c = report.tracks.company, i = report.tracks.icp;
  return {
    schema: report.schema,
    namesLimit: report.namesLimit, icpLimit: report.icpLimit,
    wantedly: {
      pagesScanned: w.pagesScanned, extracted: w.extracted,
      extractionRate: w.extractionRate, dictFullRate: w.dictFullRate,
      garbage: w.garbage, garbageRate: w.garbageRate, loose: w.loose, bareSurname: w.bareSurname,
    },
    company: {
      pagesScanned: c.pagesScanned, baseHit: c.baseHit, heurHit: c.heurHit,
      baseExtractionRate: c.baseExtractionRate, garbage: c.garbage,
    },
    icp: {
      recordsScored: i.recordsScored, meanScore: i.meanScore, medianScore: i.medianScore,
      scoreDist: i.scoreDist,
    },
  };
}

// ── 基準との比較（回帰ゲートの本体）──
function compareToBaseline(report, baseline) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail });

  // ICP: per-item 完全一致（最も強い不変条件）
  {
    const cur = report.tracks.icp.items, base = baseline.tracks.icp.items;
    let changed = 0, missing = 0; const examples = [];
    for (const k of Object.keys(base)) {
      if (!(k in cur)) { missing++; continue; }
      if (cur[k] !== base[k]) { changed++; if (examples.length < 5) examples.push(`${k}: ${base[k]}→${cur[k]}`); }
    }
    add('ICP score 完全一致', changed === 0,
      `変化 ${changed}件 / 欠落 ${missing}件 / 基準 ${Object.keys(base).length}件` + (examples.length ? ` 例:[${examples.join(', ')}]` : ''));
  }

  // 氏名（Wantedly）: 集計指標 + per-item 退行
  {
    const cw = report.tracks.wantedly, bw = baseline.tracks.wantedly;
    add('氏名 抽出率(Wantedly) 維持', cw.extractionRate >= bw.extractionRate - TOL.extractionRate,
      `現 ${cw.extractionRate}% / 基準 ${bw.extractionRate}%（許容 -${TOL.extractionRate}pp）`);
    add('氏名 辞書フルネーム率 維持', cw.dictFullRate >= bw.dictFullRate - TOL.dictFullRate,
      `現 ${cw.dictFullRate}% / 基準 ${bw.dictFullRate}%（許容 -${TOL.dictFullRate}pp）`);
    add('氏名 ゴミ率 非増加(Wantedly)', cw.garbageRate <= bw.garbageRate + TOL.garbageRate,
      `現 ${cw.garbageRate}% / 基準 ${bw.garbageRate}%`);

    const cur = cw.items, base = bw.items;
    let regress = 0; const ex = [];
    for (const url of Object.keys(base)) {
      const had = base[url], now = url in cur ? cur[url] : '';
      // 基準で有効名が取れていたのに、今は空 or 別名になった＝退行候補
      if (had && now !== had) { regress++; if (ex.length < 5) ex.push(`${url} ${had}→${now || '(空)'}`); }
    }
    add('氏名 per-item 非退行(Wantedly)', regress === 0,
      `有効名が変化/消失 ${regress}件 / 基準 ${Object.keys(base).length}ページ` + (ex.length ? ` 例:[${ex.join(' | ')}]` : ''));
  }

  // 氏名（会社採用ページ）: ゴミ非増加 + per-item 退行
  {
    const cc = report.tracks.company, bc = baseline.tracks.company;
    add('氏名 ゴミ件数 非増加(会社ページ)', cc.garbage <= bc.garbage,
      `現 ${cc.garbage}件 / 基準 ${bc.garbage}件`);
    const cur = cc.items, base = bc.items;
    let regress = 0;
    for (const url of Object.keys(base)) {
      const had = base[url], now = url in cur ? cur[url] : '';
      if (had && now !== had) regress++;
    }
    add('氏名 per-item 非退行(会社ページ)', regress === 0, `変化/消失 ${regress}件`);
  }

  const pass = checks.every((c) => c.status === 'PASS');
  return { pass, checks };
}

function appendHistory(entry) {
  ensureDir();
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
}
function readHistory() {
  if (!fs.existsSync(HISTORY)) return [];
  return fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function printSummary(report, title) {
  const s = summarize(report);
  console.log(`\n=== ${title} ===`);
  console.log(`[氏名/Wantedly] 走査 ${s.wantedly.pagesScanned}p ｜ 抽出 ${s.wantedly.extracted}（抽出率 ${s.wantedly.extractionRate}%）`);
  console.log(`              辞書フルネーム率 ${s.wantedly.dictFullRate}% ｜ ゴミ率 ${s.wantedly.garbageRate}%（${s.wantedly.garbage}件）｜ loose ${s.wantedly.loose} ｜ bare ${s.wantedly.bareSurname}`);
  console.log(`[氏名/会社ページ] 走査 ${s.company.pagesScanned}p ｜ base抽出 ${s.company.baseHit}（${s.company.baseExtractionRate}%）｜ ゴミ ${s.company.garbage}件`);
  console.log(`[ICP] 採点 ${s.icp.recordsScored}件 ｜ 平均 ${s.icp.meanScore} ｜ 中央 ${s.icp.medianScore}`);
}

function runEval(override) {
  const namesLimit = override && override.namesLimit != null ? override.namesLimit : parseInt(arg('names-limit', '1500'), 10);
  const icpLimit = override && override.icpLimit != null ? override.icpLimit : parseInt(arg('icp-limit', '0'), 10);
  return evaluate({ namesLimit: Number.isFinite(namesLimit) ? namesLimit : 1500, icpLimit: Number.isFinite(icpLimit) ? icpLimit : 0 });
}

function writeLatest(report) { ensureDir(); fs.writeFileSync(LATEST, JSON.stringify(report)); }

function regenDashboard() {
  ensureDir();
  fs.writeFileSync(DASHBOARD, buildHtml(readHistory()));
  console.log('ダッシュボード生成: ' + path.relative(ROOT, DASHBOARD));
}

function main() {
  const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'run';
  const label = arg('label', '');
  const sha = gitSha();

  if (cmd === 'dashboard') { regenDashboard(); return; }

  // gate は基準と同一母集団で比較しないと未走査ページを誤検出する → 基準の母集団サイズを使う。
  let override = null;
  if (cmd === 'gate') {
    if (!fs.existsSync(BASELINE)) { console.error('基準が無い。先に `node src/eval/cli.js baseline` を実行。'); process.exit(2); }
    const b = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    override = { namesLimit: b.namesLimit, icpLimit: b.icpLimit };
  }

  const report = runEval(override);
  writeLatest(report);
  const sum = summarize(report);

  if (cmd === 'baseline') {
    ensureDir();
    fs.writeFileSync(BASELINE, JSON.stringify(report));
    printSummary(report, 'ベースライン固定');
    appendHistory({ at: nowIso(), sha, label: label || 'baseline', kind: 'baseline', metrics: sum });
    regenDashboard();
    console.log('\n基準を凍結: ' + path.relative(ROOT, BASELINE));
    return;
  }

  if (cmd === 'gate') {
    if (!fs.existsSync(BASELINE)) { console.error('基準が無い。先に `node src/eval/cli.js baseline` を実行。'); process.exit(2); }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const verdict = compareToBaseline(report, baseline);
    printSummary(report, '回帰ゲート');
    console.log('\n--- 判定 ---');
    for (const c of verdict.checks) console.log(`  ${c.status === 'PASS' ? '✓' : '✗'} ${c.name}: ${c.detail}`);
    appendHistory({ at: nowIso(), sha, label: label || 'gate', kind: 'gate', pass: verdict.pass, metrics: sum, checks: verdict.checks.map((c) => ({ name: c.name, status: c.status })) });
    regenDashboard();
    if (!verdict.pass) { console.log('\n✗ 精度退行を検出。リファクタ内容を見直すか、意図的変更なら baseline を更新。'); process.exit(1); }
    console.log('\n✓ 精度低下なし（基準を維持）。');
    return;
  }

  // run
  printSummary(report, '評価');
  appendHistory({ at: nowIso(), sha, label: label || 'run', kind: 'run', metrics: sum });
  regenDashboard();
}

main();
