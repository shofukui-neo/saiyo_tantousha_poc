'use strict';
/**
 * build-hotlead-list — 「今日のホットリード」架電リスト生成
 * =====================================================================
 * 企業リストを上から架電するのをやめ、**採用ニーズが発生した企業だけ**を毎日抽出する。
 *
 * フロー:
 *   1) テキストシグナル … data/hot-signals/releases.jsonl（harvest-signals が収集）
 *   2) 差分シグナル     … signal-store の台帳（求人急増 / 長期掲載 / 新規掲載開始）
 *   3) 企業単位に集約   … company-match の正規化キーで1社1行に畳む
 *   4) 採点             … hot-signal.scoreHotLead（熱度×鮮度×ICP適合×架電可能性）
 *   5) 除外突合         … exclusion-index（MOCHICA顧客 / BALES / SF / 納品台帳）
 *                         ※既定は「完全新規のみ」。既存も見たいときは --include-existing
 *   6) 出力             … data/leads-hotlead-YYYYMMDD.csv（架電用スプシ形式＋HOT列）
 *
 * 実行:
 *   npm run hot                          # 既存の収集済みシグナルからリスト生成
 *   npm run hot:harvest                  # PR TIMES を収集してからリスト生成
 *   node src/build-hotlead-list.js --limit 100 --min-score 65
 *   node src/build-hotlead-list.js --rank S,A --record       # 台帳へ記録（再出力を防ぐ）
 *   node src/build-hotlead-list.js --include-existing        # 既存CRM企業も残す（再アプローチ用）
 *
 * 前提: 差分シグナル（求人急増/長期掲載）は 2回以上のスナップショットが必要。
 *       `node src/signal-store.js ingest <csv> --source mynavi` を日次で回すこと。
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { toCsv } = require('./csv');
const { looseKey } = require('./company-match');
const { buildExclusionIndex } = require('./exclusion-index');
const { appendRecords, DEFAULT_LEDGER } = require('./delivered-ledger');
const { scoreHotLead, talkOpener, detectDeltaSignals, daysAgo } = require('./hot-signal');
const { loadStore, ymd } = require('./signal-store');
const { isExcludedIndustry, proposalTier } = require('./icp-rules');
const { getArg, getIntArg, log } = require('./cli-util');
const { JSONL } = require('./harvest-signals');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = {
    in: String(getArg('in', JSONL)),
    limit: getIntArg('limit', 100),             // 「毎日100社」を既定にする
    minScore: getIntArg('min-score', 50),       // Bランク以上
    longDays: getIntArg('long-days', 90),       // 長期掲載とみなす日数
    ranks: null,
    out: getArg('out', ''),
    includeExisting: argv.includes('--include-existing'),
    record: argv.includes('--record'),
    noDelta: argv.includes('--no-delta'),
    deliver: argv.includes('--deliver'),                // 完成CSVをダウンロードフォルダへ複製
    allIndustries: argv.includes('--all-industries'),   // 既定はIT除外（ICPハードルール）
  };
  const r = getArg('rank', '');
  if (r && r !== true) a.ranks = new Set(String(r).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  if (!a.out || a.out === true) a.out = path.join('data', `leads-hotlead-${ymd().replace(/-/g, '')}.csv`);
  return a;
}

/** releases.jsonl を読み、企業キー→レコードに畳む。 */
function loadTextSignals(file) {
  const byKey = new Map();
  if (!fs.existsSync(file)) return byKey;
  let broken = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { broken++; continue; }
    const name = String(j.company || '').trim();
    if (!name) continue;
    const k = looseKey(name);
    if (!k) continue;
    const cur = byKey.get(k) || { name, key: k, signals: [], sources: new Set(), facts: {} };
    // 社名は最も長い表記を採る（略記より正式名の方が架電時に正しい）
    if (name.length > cur.name.length) cur.name = name;
    for (const s of (j.signals || [])) cur.signals.push({ ...s, url: s.url || j.url, date: j.date });
    cur.sources.add('PR TIMES');
    // 企業属性は「先に埋まったものを保持」（同一社の後続リリースで空に上書きしない）
    for (const [f, v] of Object.entries({
      公式URL: j.公式URL, 業種: j.業種, 都道府県: j.都道府県, 電話番号: j.電話番号,
      代表者名: j.代表者名, 採用担当者名: j.採用担当者名, 担当役職: j.担当役職, 上場: j.上場, 根拠URL: j.url,
    })) if (v && !cur.facts[f]) cur.facts[f] = String(v);
    byKey.set(k, cur);
  }
  if (broken) log(`⚠ 壊れたJSONL行を ${broken}件スキップしました`);
  return byKey;
}

/**
 * signal-store の台帳から差分シグナルを作る。
 * ingest 済みの状態を「今日の観測」として読み直し、長期掲載を含めて再判定する
 * （ingest 時点の判定は保存していないため、リスト生成側で毎回作り直すのが正）。
 */
function loadDeltaSignals(longDays) {
  const store = loadStore();
  const byKey = new Map();
  for (const [k, c] of Object.entries(store.companies || {})) {
    if (c.seen === false) continue;                       // 掲載が消えた企業は今日のホットではない
    const hist = c.history || [];
    const prev = hist.length >= 2 ? { jobs: hist[hist.length - 2].jobs, hire: hist[hist.length - 2].hire, seen: true } : null;
    const signals = detectDeltaSignals(prev, c, { asOf: c.lastSeen, longDays });
    if (!signals.length) continue;
    // 差分は「その観測日に起きたこと」。台帳の取り込みが止まれば古くなるので、
    // 最終観測日からの経過を鮮度として持たせる（days:0 のままだと万年ホットになる）。
    const age = daysAgo(c.lastSeen);
    for (const s of signals) s.days = age == null ? 0 : Math.max(0, age);
    byKey.set(k, {
      name: c.name, key: k, signals, sources: new Set([c.source || '求人媒体スナップショット']),
      facts: { 公式URL: c.url || '', 業種: c.industry || '', 都道府県: c.pref || '', 電話番号: c.phone || '', 採用担当者名: c.contactName || '' },
      obs: { emp: c.emp, hire: c.hire, jobs: c.jobs, firstSeen: c.firstSeen, lastSeen: c.lastSeen },
    });
  }
  return byKey;
}

// 2つのシグナル源を1社1レコードに統合する
function mergeSources(a, b) {
  const out = new Map(a);
  for (const [k, v] of b) {
    const cur = out.get(k);
    if (!cur) { out.set(k, v); continue; }
    cur.signals.push(...v.signals);
    for (const s of v.sources) cur.sources.add(s);
    for (const [f, val] of Object.entries(v.facts || {})) if (val && !cur.facts[f]) cur.facts[f] = val;
    if (v.obs) cur.obs = Object.assign({}, v.obs, cur.obs);
    if (v.name && v.name.length > cur.name.length) cur.name = v.name;
  }
  return out;
}

// 同一シグナル種別が複数本ある場合は最新の1本に畳む（同じ出来事の重複加点を防ぐ）
function dedupeSignals(signals) {
  const best = new Map();
  for (const s of signals) {
    const cur = best.get(s.key);
    const d = s.days == null ? 9999 : s.days;
    const cd = cur && cur.days == null ? 9999 : (cur ? cur.days : 99999);
    if (!cur || d < cd) best.set(s.key, s);
  }
  return [...best.values()];
}

const OUT_HEADERS = [
  'ランク', 'HOTスコア', '企業名', '電話番号', '担当者名', '架電宛名',
  'なぜ今なのか', '推定課題', '今日の切り出し',
  '検出シグナル', '最新シグナル', 'シグナル発生', '採用人数', '従業員数', '業種', '都道府県',
  '提案セグメント', '公式URL', '根拠URL', 'シグナル源', 'スコア根拠', '既存被り', '作成日',
];

function run() {
  const a = parseArgs(process.argv);
  const today = ymd();

  // ── 1) シグナルを集める ────────────────────────────────────
  const text = loadTextSignals(path.resolve(a.in));
  const delta = a.noDelta ? new Map() : loadDeltaSignals(a.longDays);
  const merged = mergeSources(text, delta);
  log(`シグナル保有企業 ${merged.size}社（テキスト ${text.size} / 差分 ${delta.size}）`);
  if (!merged.size) {
    console.error('\nシグナルが1件もありません。先に収集してください:');
    console.error('  npm run hot:harvest              # PR TIMES からテキストシグナルを収集');
    console.error('  node src/signal-store.js ingest <求人CSV> --source mynavi   # 差分の元を貯める');
    process.exit(1);
  }

  // ── 2) 採点 ───────────────────────────────────────────────
  const drop = {};
  const scored = [];
  for (const c of merged.values()) {
    const f = c.facts || {};
    const obs = c.obs || {};
    const signals = dedupeSignals(c.signals);
    const contactName = f.採用担当者名 || '';
    const sc = scoreHotLead({
      signals, emp: obs.emp, hire: obs.hire, industry: f.業種,
      phone: f.電話番号, contactName, repName: f.代表者名, company: c.name,
    });
    if (!a.allIndustries && isExcludedIndustry(f.業種)) { drop['IT/ソフト=ICP絶対除外'] = (drop['IT/ソフト=ICP絶対除外'] || 0) + 1; continue; }
    if (sc.score < a.minScore) { drop[`スコア<${a.minScore}`] = (drop[`スコア<${a.minScore}`] || 0) + 1; continue; }
    if (a.ranks && !a.ranks.has(sc.rank)) { drop[`ランク対象外(${sc.rank})`] = (drop[`ランク対象外(${sc.rank})`] || 0) + 1; continue; }
    scored.push({ c, signals, sc, contactName });
  }
  log(`採点通過 ${scored.length}社`);

  // ── 3) 除外突合（3マスタ＋納品台帳）────────────────────────
  const ex = buildExclusionIndex();
  let existing = 0;
  const rows = [];
  for (const x of scored) {
    const hit = ex.idx.matchDetail({ 企業名: x.c.name });
    if (hit.matched) {
      existing++;
      if (!a.includeExisting) { drop[`既存被り(${hit.label})`] = (drop[`既存被り(${hit.label})`] || 0) + 1; continue; }
    }
    x.dup = hit.matched ? `${hit.label}（${hit.tier}一致）` : '';
    rows.push(x);
  }

  // ── 4) 並べ替え・上限 ─────────────────────────────────────
  rows.sort((p, q) => (q.sc.score - p.sc.score) || (q.sc.heat - p.sc.heat) || p.c.name.localeCompare(q.c.name));
  const cut = a.limit > 0 ? rows.slice(0, a.limit) : rows;

  // ── 5) 出力 ───────────────────────────────────────────────
  const recs = cut.map((x) => {
    const f = x.c.facts || {};
    const obs = x.c.obs || {};
    const top = x.sc.top;
    const name = x.contactName || f.代表者名 || '';
    return {
      ランク: x.sc.rank,
      HOTスコア: String(x.sc.score),
      企業名: x.c.name,
      電話番号: f.電話番号 || '',
      担当者名: name,
      架電宛名: name ? `${name} 様` : '',
      なぜ今なのか: x.sc.why.join(' / '),
      推定課題: x.sc.issue,
      今日の切り出し: talkOpener(top, x.c.name),
      検出シグナル: x.signals.map((s) => s.key).join('／'),
      最新シグナル: top ? top.key : '',
      シグナル発生: top && top.days != null ? (top.days <= 0 ? '本日' : `${top.days}日前`) : '',
      採用人数: obs.hire != null ? String(obs.hire) : '',
      従業員数: obs.emp != null ? String(obs.emp) : '',
      業種: f.業種 || '',
      都道府県: f.都道府県 || '',
      提案セグメント: proposalTier(obs.emp == null ? null : obs.emp).segment,
      公式URL: f.公式URL || '',
      根拠URL: (top && top.url) || f.根拠URL || '',
      シグナル源: [...x.c.sources].join('／'),
      スコア根拠: x.sc.reasons.join(' / '),
      既存被り: x.dup || '',
      作成日: today,
    };
  });
  const OUT = path.resolve(ROOT, a.out);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, '﻿' + toCsv(OUT_HEADERS, recs), 'utf8');

  // 最終成果物はダウンロードフォルダに置く運用のため、--deliver で複製する
  let delivered = '';
  if (a.deliver) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const dl = path.join(home, 'Downloads');
    if (home && fs.existsSync(dl)) { delivered = path.join(dl, path.basename(OUT)); fs.copyFileSync(OUT, delivered); }
    else console.warn('[hotlead] ⚠ ダウンロードフォルダが見つからないため複製をスキップしました');
  }

  // ── 6) 納品台帳へ記録（再出力を防ぐ）──────────────────────
  let ledger = null;
  if (a.record) {
    ledger = appendRecords(DEFAULT_LEDGER, recs.map((r) => ({ 企業名: r.企業名 })), {
      batch: `hotlead-${today}`, source: path.relative(ROOT, OUT), date: today,
    });
  }

  // ── サマリ ───────────────────────────────────────────────
  const tally = (fn) => { const m = {}; for (const x of cut) { const k = fn(x) || '(不明)'; m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((p, q) => q[1] - p[1]); };
  const sigTally = {};
  for (const x of cut) for (const s of x.signals) sigTally[s.key] = (sigTally[s.key] || 0) + 1;

  console.log('\n─────────────────────────────────────────────');
  console.log('[hotlead] 採用シグナル → ホットリード');
  console.log('─────────────────────────────────────────────');
  console.log(`  シグナル保有        ${merged.size}社（テキスト ${text.size} / 差分 ${delta.size}）`);
  console.log(`  既存マスタと一致    ${existing}社${a.includeExisting ? '（--include-existing のため残置）' : '（除外済み）'}`);
  console.log('\n[hotlead] 除外の内訳');
  for (const [k, v] of Object.entries(drop).sort((p, q) => q[1] - p[1])) console.log(`  ${String(v).padStart(4)}社  ${k}`);
  console.log(`\n[hotlead] 完成リスト ${cut.length}社（候補 ${rows.length}社中）`);
  console.log(`  ランク       ${tally((x) => x.sc.rank).map(([k, v]) => `${k}:${v}`).join(' / ')}`);
  console.log(`  電話あり     ${cut.filter((x) => x.c.facts.電話番号).length}社`);
  console.log(`  名指し可能   ${cut.filter((x) => x.contactName).length}社（採用担当者名）`);
  console.log(`  宛名あり     ${cut.filter((x) => x.contactName || x.c.facts.代表者名).length}社（代表者名を含む）`);
  console.log('\n  シグナル内訳');
  for (const [k, v] of Object.entries(sigTally).sort((p, q) => q[1] - p[1])) console.log(`    ${String(v).padStart(4)}社  ${k}`);
  console.log('\n  上位10社');
  for (const x of cut.slice(0, 10)) {
    console.log(`    ${x.sc.rank} ${String(x.sc.score).padStart(3)}点 ${x.c.name}（${x.signals.map((s) => s.key).join('+')}）`);
  }
  if (ledger) console.log(`\n[hotlead] 納品台帳へ記録: 新規${ledger.added}社 / 既出${ledger.skipped}社 / 累計${ledger.total}社`);
  else console.log('\n[hotlead] 台帳未記録（--record を付けると次回以降このリストの企業を再出力しません）');
  console.log(`[hotlead] out: ${path.relative(ROOT, OUT)}（${OUT_HEADERS.length}列）`);
  if (delivered) console.log(`[hotlead] ダウンロードへ複製: ${delivered}`);
}

if (require.main === module) {
  try { run(); } catch (e) { console.error(e); process.exit(1); }
}

module.exports = { loadTextSignals, loadDeltaSignals, mergeSources, dedupeSignals, OUT_HEADERS };
