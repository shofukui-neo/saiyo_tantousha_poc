'use strict';
/**
 * 全ソース共通のリード作成 CLI（設計: docs/all-source-lead-plan.md §3）
 * =====================================================================
 *   node src/source-run.js list
 *       登録簿のソース一覧（状態・法務区分・最新スナップショット）
 *
 *   node src/source-run.js collect <id> [--file x] [--max-files N]
 *       アダプタで収集して data/obs/<id>/<日付>.jsonl に保存する（除外・採点はしない）
 *
 *   node src/source-run.js build <id[,id...]|all> [--pilot 200] [--fresh-only] [--min-stage L2]
 *                                [--gbiz N] [--min-sites 10] [--out x.csv] [--record --batch 名前]
 *       最新スナップショットを名寄せ → エンリッチ → ゲート → 段階判定 → 採点 → CSV出力 → スコアカード
 *       --pilot N    社名ハッシュ順のN社だけで試す（新しいソースは200社で試してから全件を回す）
 *       --fresh-only 既存母集団（未納品だが既知）も落とす
 *       --min-stage  出力に載せる最低段階（既定 L0 = 全段階）
 *       --record     出力した会社を納品済み台帳に記録する（実際に納品する1本だけで使う）
 *
 *   node src/source-run.js kpi <id[,id...]|all> [--pilot 200]
 *       build と同じ判定を回してスコアカードだけ出す（CSVは書かない）
 *
 *   ── 新卒媒体カタログ（src/sources/media.json、1媒体＝1ソース m-<ホスト名>）──
 *   node src/source-run.js media-sync                     data/media-catalog.json から媒体を同期
 *   node src/source-run.js media-probe [--only id,id] [--status planned,unverified] [--concurrency 6]
 *       規約・robots・企業詳細の型・試し抽出を判定して media.json に書く
 *   node src/source-run.js media-status                   状態別の件数と、止まっている理由
 *   node src/source-run.js collect-media [--only id,id] [--max-detail 300] [--concurrency 6]
 *       active の媒体をまとめて収集（媒体の間は並列、同じ媒体の中は polite.js で直列）
 */
const fs = require('fs');
const path = require('path');
const reg = require('./sources/registry');
const store = require('./sources/store');
const { normalize } = require('./sources/observation');
const { resolveCompanies } = require('./sources/resolve');
const { runPipeline, scorecard, pilotSample, OUTPUT_HEADERS, EXCLUDED_HEADERS, STAGES } = require('./sources/pipeline');
const { enrichWithGbiz } = require('./sources/enrich');
const { buildExclusionIndex } = require('./exclusion-index');
const { appendRecords, DEFAULT_LEDGER } = require('./delivered-ledger');
const { toCsv } = require('./csv');
const { getArg, getIntArg, log } = require('./cli-util');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const v = argv[i + 1];
    args[argv[i].slice(2)] = v && !v.startsWith('--') ? v : true;
  }
  return args;
}

function cmdList(args) {
  const all = reg.list();
  const media = all.filter((s) => s.media);
  const rows = (args.media ? media : all.filter((s) => !s.media)).map((s) => {
    const snap = store.listSnapshots(s.id);
    return { id: s.id, 区分: s.group, 法務: s.legal_tier, 状態: s.status, ICP: s.icp_prior,
      最新: snap.length ? path.basename(snap[snap.length - 1], '.jsonl') : '', 名称: s.name };
  });
  console.table(rows);
  if (!args.media) {
    const by = {};
    for (const m of media) by[m.status] = (by[m.status] || 0) + 1;
    console.log(`新卒媒体 ${media.length} 媒体: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' / ')}（一覧は list --media、理由は media-status）`);
  }
}

/** 同時に limit 件まで fn を回す。 */
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it).catch((e) => log(`[${it.id || it}] エラー: ${e.message}`)); }
  });
  await Promise.all(workers);
}

function cmdMediaSync() {
  const r = require('./sources/media-registry').syncFromCatalog();
  log(`媒体カタログを同期: 追加 ${r.added} / 合計 ${r.total} 媒体 → src/sources/media.json`);
}

async function cmdMediaProbe(args) {
  const mr = require('./sources/media-registry');
  const doc = mr.load();
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const statuses = new Set(String(args.status || 'planned,unverified').split(','));
  const targets = doc.media.filter((m) => (only ? only.has(m.id) : statuses.has(m.status)));
  log(`プローブ: ${targets.length} 媒体（並列 ${getIntArg('concurrency', 6)}）`);
  let done = 0;
  await pool(targets, getIntArg('concurrency', 6), async (m) => {
    await mr.probeMedia(m, (x) => log(x));
    done++;
    mr.saveMedia([m]); // 1媒体ごとに、その媒体だけ保存（途中で止めても判定が残る・並行の手編集を消さない）
    log(`  [${done}/${targets.length}] ${m.id}: ${m.status}${m.reason ? '（' + m.reason + '）' : ''}`);
  });
  cmdMediaStatus();
}

function cmdMediaStatus() {
  const media = require('./sources/media-registry').load().media;
  const by = {};
  for (const m of media) {
    const k = `${m.status}${m.reason ? '｜' + m.reason.replace(/（[^）]*）/g, '').slice(0, 40) : ''}`;
    by[k] = (by[k] || 0) + 1;
  }
  console.table(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ 状態と理由: k, 媒体数: v })));
}

async function cmdCollectMedia(args) {
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const targets = reg.list().filter((s) => s.media && s.status === 'active' && (!only || only.has(s.id)));
  log(`媒体の収集: ${targets.length} 媒体（並列 ${getIntArg('concurrency', 6)}・1媒体あたり最大 ${args['max-detail'] || 300} 詳細）`);
  await pool(targets, getIntArg('concurrency', 6), (s) => cmdCollect(s.id, args));
}

async function cmdCollect(id, args) {
  const src = reg.get(id);
  const adapter = reg.adapterOf(src);
  const date = store.ymd();
  log(`[${id}] 収集開始（${src.name}）`);
  const { observations, meta } = await adapter.collect({ source: src, args, log: (m) => log(`[${id}] ${m}`) });
  const good = [];
  const bad = [];
  for (const raw of observations) {
    const r = normalize(raw, id, date);
    (r.ok ? good : bad).push(r);
  }
  const p = store.writeSnapshot(id, good.map((r) => r.obs), date);
  log(`[${id}] 観測 ${good.length.toLocaleString()} 件を保存 → ${path.relative(ROOT, p)}`);
  if (bad.length) log(`[${id}] ⚠ 不備で捨てた観測 ${bad.length} 件（例: ${bad[0].errors.join(' / ')}）`);
  if (meta) log(`[${id}] meta ${JSON.stringify(meta)}`);
}

function idsOf(spec) {
  if (!spec || spec === true) throw new Error('ソースIDを指定してください（例: kaigo-kouhyou,kenko-keiei / all）');
  if (spec === 'all') return reg.list().filter((s) => store.listSnapshots(s.id).length).map((s) => s.id);
  return String(spec).split(',').map((s) => s.trim()).filter(Boolean);
}

function printScorecard(cards) {
  console.table(cards.map((k) => ({
    ソース: k.source, 社数: k.社数, 新規率: `${k.新規率}%`, ICP適合率: `${k.ICP適合率}%`,
    電話率: `${k.電話率}%`, 担当者名率: `${k.担当者名率}%`, 新卒6名以上率: `${k.新卒6名以上率}%`, 業種あり率: `${k.業種あり率}%`,
    L0: k.段階.L0, L1: k.段階.L1, L2: k.段階.L2, L3: k.段階.L3,
    既存除外: k.除外.既存, NG: k.除外.NG, IT: k.除外.IT, 官公庁: k.除外.官公庁, フロア未満: k.除外.フロア未満, 同名: k.除外.同名の別法人,
  })));
}

async function cmdBuild(spec, args, { write }) {
  const ids = idsOf(spec);
  const date = store.ymd();
  const obs = [];
  for (const id of ids) {
    const src = reg.get(id);
    const snap = store.latestSnapshot(id);
    if (!snap) throw new Error(`[${id}] スナップショットがありません。先に collect ${id} を実行してください`);
    log(`[${id}] ${snap.date} の観測 ${snap.observations.length.toLocaleString()} 件（${src.status}）`);
    obs.push(...snap.observations);
  }
  const relOf = (id) => { try { return reg.get(id).reliability || 1; } catch { return 1; } };
  let companies = resolveCompanies(obs, { reliabilityOf: relOf });
  log(`名寄せ: 観測 ${obs.length.toLocaleString()} → ${companies.length.toLocaleString()} 社`);
  const pilot = getIntArg('pilot', 0);
  if (pilot) { companies = pilotSample(companies, pilot); log(`パイロット: ${companies.length} 社に絞りました`); }

  const g = await enrichWithGbiz(companies, { limit: getIntArg('gbiz', 0), log });
  if (g.skipped) log(`gBizINFO 補完をスキップ: ${g.skipped}`);

  const exclusion = buildExclusionIndex();                      // 顧客/BALES/SF/納品済み台帳 → 除外
  const pool = buildExclusionIndex({ layers: ['pool'] });       // 既存母集団 → 印だけ
  const result = runPipeline(companies, {
    exclusion, pool, date, minSites: getIntArg('min-sites', 10), freshOnly: !!getArg('fresh-only', false),
  });
  const cards = scorecard(result, ids);
  printScorecard(cards);
  store.appendKpiHistory({ at: new Date().toISOString(), ids, pilot: pilot || null, cards });

  if (!write) return;
  const minStage = String(getArg('min-stage', 'L0'));
  if (!STAGES.includes(minStage)) throw new Error(`--min-stage は ${STAGES.join('/')} のいずれか`);
  const rows = result.kept.filter((k) => STAGES.indexOf(k.c.stage) >= STAGES.indexOf(minStage)).map((k) => k.row);
  const tag = `${ids.join('+')}${pilot ? `-pilot${pilot}` : ''}`;
  const out = path.resolve(ROOT, String(getArg('out', `data/leads-src-${tag}-${date}.csv`)));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, '﻿' + toCsv(OUTPUT_HEADERS, rows, { where: path.basename(out) }));
  const exOut = out.replace(/\.csv$/i, '.excluded.csv');
  fs.writeFileSync(exOut, '﻿' + toCsv(EXCLUDED_HEADERS, result.excluded.map((e) => e.row), { where: path.basename(exOut) }));
  log(`出力: ${path.relative(ROOT, out)}（${rows.length.toLocaleString()} 社・${minStage}以上）`);
  log(`除外明細: ${path.relative(ROOT, exOut)}（${result.excluded.length.toLocaleString()} 社。NG該当は明細にも書かない）`);

  if (getArg('record', false)) {
    const batch = String(getArg('batch', `src-${tag}-${date}`));
    const r = appendRecords(DEFAULT_LEDGER, rows, { batch, source: path.basename(out) });
    log(`納品済み台帳に記録: 追加 ${r.added} / 既出 ${r.skipped}（バッチ ${batch}）`);
  }
}

async function main() {
  const [cmd, target] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  if (cmd === 'list') return cmdList(args);
  if (cmd === 'media-sync') return cmdMediaSync();
  if (cmd === 'media-probe') return cmdMediaProbe(args);
  if (cmd === 'media-status') return cmdMediaStatus();
  if (cmd === 'collect-media') return cmdCollectMedia(args);
  if (cmd === 'collect') return cmdCollect(target, args);
  if (cmd === 'build') return cmdBuild(target, args, { write: true });
  if (cmd === 'kpi') return cmdBuild(target, args, { write: false });
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 28).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
}

main().catch((e) => { console.error(`エラー: ${e.message}`); process.exit(1); });
