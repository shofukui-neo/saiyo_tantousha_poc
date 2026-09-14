'use strict';
/**
 * harvest-site-signals — 自社が持つICP企業を巡回してインテントを取る（第一者相当の収集）
 * =====================================================================
 * 何が問題だったか:
 *   シグナル収集が PR TIMES 1本だった。PR TIMES に載るのはリリースを出す企業＝
 *   スタートアップとITに強く偏り、ICP（非IT × 従業員300-500名 × 新卒6名以上）と
 *   ほとんど重ならない。母数も154本しかなく、毎日のホットリストが作れない。
 *
 * ここでやること:
 *   既に持っている企業台帳（leads-consolidated-all.csv 等・28,000社）から
 *   **ICP適合かつURLを持つ企業だけ**を巡回対象（watchlist）にし、
 *   毎日一定数ずつローテーションで公式サイト／採用ページを見にいく。
 *     1周目 … テキストシグナル（採用強化・新拠点・インターン募集 …）＋ページ指紋を記録
 *     2周目以降 … 指紋の変化から「採用ページ更新」「新着情報更新」を差分で作る
 *   ＝ 出来事を待つのではなく、ICPの企業を定点観測して変化を捕まえる。
 *
 * 出力:
 *   data/hot-signals/site-signals.jsonl … releases.jsonl と同じ形（build-hotlead-list が両方読む）
 *   data/hot-signals/site-state.json    … 企業ごとの巡回状態（lastCrawled / 指紋 / 初回観測日）
 *   data/hot-signals/audit/YYYY-MM.jsonl … 全判定の監査ログ（採択率を後から測るため）
 *
 * 実行:
 *   npm run hot:site                       # ICP優先で300社巡回（古い順のローテーション）
 *   node src/harvest-site-signals.js --limit 100 --conc 6
 *   node src/harvest-site-signals.js --sweet          # 従業員300-500名（主戦場）だけ
 *   node src/harvest-site-signals.js --all-industries # IT除外を外す
 *   node src/harvest-site-signals.js --stats          # 巡回状況だけ表示して終了
 *
 * 作法: 取得は全て polite 経由（robots.txt 遵守・ホスト別レート制限）。1社あたり最大4ページ。
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { readCsv } = require('./csv');
const { looseKey, pickName } = require('./company-match');
const { isExcludedIndustry, ICP } = require('./icp-rules');
const { crawlCompany } = require('./site-signal');
const { detectSiteDiffSignals } = require('./hot-signal');
const { appendAudit } = require('./signal-audit');
const { ymd } = require('./signal-store');
const { log, getArg, getIntArg, loadJson, atomicWrite } = require('./cli-util');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'hot-signals');
const STATE = path.join(DIR, 'site-state.json');
const JSONL = path.join(DIR, 'site-signals.jsonl');

// 求人媒体のホスト。企業の「公式サイト」欄にこれが入っていることが実際に多いが、
// 一次情報ではないので採用ページ扱いにする（同一ホストに巡回が集中して遅くなる問題もある）。
const MEDIA_HOST = /(job\.mynavi\.jp|job\.rikunabi\.net|rikunabi\.com|en-japan\.com|doda\.jp|type\.jp|mynavi\.jp|indeed\.com|xn--pckua2a7gp15o89zb)/i;

const DEFAULT_SOURCES = [
  'data/leads-consolidated-all.csv',
];

function parseArgs(argv) {
  const a = {
    limit: getIntArg('limit', 300),
    conc: getIntArg('conc', 4),
    maxPages: getIntArg('max-pages', 4),
    mediaMax: getIntArg('media-max', 60),    // 媒体ホストは直列になるので1回あたりの本数を絞る
    sources: String(getArg('sources', DEFAULT_SOURCES.join(','))).split(',').map((s) => s.trim()).filter(Boolean),
    sweet: argv.includes('--sweet'),
    allIndustries: argv.includes('--all-industries'),
    stats: argv.includes('--stats'),
    rebuild: argv.includes('--rebuild'),      // watchlist を作り直す（台帳が更新されたとき）
  };
  return a;
}

const g = (r, keys) => { for (const k of keys) { const v = r[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); } return ''; };
const toInt = (v) => { const m = String(v == null ? '' : v).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/,/g, '').match(/\d+/); return m ? parseInt(m[0], 10) : null; };

/**
 * 企業台帳CSV群 → 巡回対象（watchlist）。
 * 巡回コストは有限なので「誰を見るか」がそのまま成果を決める。ICP適合を優先度に直結させる。
 * @returns {Map<string, object>} 正規化キー → 対象
 */
function buildWatchlist(a) {
  const out = new Map();
  for (const rel of a.sources) {
    const file = path.resolve(ROOT, rel);
    if (!fs.existsSync(file)) { log(`⚠ 台帳が見つかりません: ${rel}`); continue; }
    const { records } = readCsv(fs.readFileSync(file, 'utf8'));
    for (const r of records) {
      const name = pickName(r) || g(r, ['企業名', '会社名', '社名']);
      if (!name) continue;
      const key = looseKey(name);
      if (!key || out.has(key)) continue;

      const industry = g(r, ['業種', '業界']);
      if (!a.allIndustries && isExcludedIndustry(industry)) continue;   // IT/ソフトはICP絶対除外
      const emp = toInt(g(r, ['従業員数', '従業員規模', '社員数']));
      if (a.sweet && !(emp != null && emp >= ICP.EMP_SWEET_MIN && emp <= ICP.EMP_SWEET_MAX)) continue;

      // URL の振り分け。媒体URLは一次情報ではないので採用ページ側に置く。
      const rawUrl = g(r, ['公式URL', 'URL', 'Webサイト', '会社情報：Webサイト']);
      const rawRecruit = g(r, ['採用ページURL', '採用サイトURL', 'マイナビURL']);
      let url = '', recruitUrl = '';
      for (const u of [rawUrl, rawRecruit]) {
        if (!/^https?:\/\//i.test(u)) continue;
        if (MEDIA_HOST.test(u)) { if (!recruitUrl) recruitUrl = u; }
        else if (!url) url = u;
      }
      if (!url && !recruitUrl) continue;                                // 巡回先が無ければ対象外

      // 優先度: 主戦場(300-500名) > ICPレンジ > その他。自社サイトがある方をさらに優先。
      let prio = 0;
      if (emp != null && emp >= ICP.EMP_SWEET_MIN && emp <= ICP.EMP_SWEET_MAX) prio += 40;
      else if (emp != null && emp >= ICP.EMP_MIN && emp <= ICP.EMP_MAX) prio += 20;
      else if (emp == null) prio += 5;
      if (url) prio += 15;                                              // 一次情報に到達できる
      const hire = toInt(g(r, ['採用予定人数', '採用人数', '新卒採用人数']));
      if (hire != null && hire >= ICP.HIRE_MIN) prio += 15;

      out.set(key, {
        key, name, url, recruitUrl, industry, prio,
        emp, hire,
        pref: g(r, ['都道府県', '会社情報：住所：都道府県']),
        phone: g(r, ['電話番号', '会社情報：電話', 'TEL']),
      });
    }
  }
  return out;
}

/** 巡回状態を読む／保存する（原子的置換）。 */
const loadState = () => loadJson(STATE, { version: 1, updated: '', companies: {} });
function saveState(st) { st.updated = new Date().toISOString(); atomicWrite(STATE, JSON.stringify(st, null, 1)); }

/**
 * 今日巡回する企業を選ぶ。
 *  ・未巡回を最優先（初回の指紋が無いと差分が永遠に出ない）
 *  ・次に「前回巡回が古い順」＝全社を一定周期で回す
 *  ・同条件なら ICP 優先度が高い順
 */
function pickTargets(watch, state, a) {
  const cs = state.companies || {};
  const arr = [...watch.values()].map((t) => {
    const s = cs[t.key];
    return { ...t, lastCrawled: (s && s.lastCrawled) || '', crawls: (s && s.crawls) || 0 };
  });
  arr.sort((x, y) => {
    if (!x.lastCrawled !== !y.lastCrawled) return x.lastCrawled ? 1 : -1;  // 未巡回が先
    if (x.lastCrawled !== y.lastCrawled) return x.lastCrawled < y.lastCrawled ? -1 : 1;
    return y.prio - x.prio;
  });
  // 媒体ホストのみの企業は同一ホストで直列化されるため本数を絞る（1社4秒×多数で1回が終わらない）
  const out = [];
  let media = 0;
  for (const t of arr) {
    if (out.length >= a.limit) break;
    if (!t.url) { if (media >= a.mediaMax) continue; media++; }
    out.push(t);
  }
  return out;
}

/** n並列で実行する軽量ワーカープール（polite がホスト別に直列化するので並列でも礼儀は保たれる）。 */
async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.max(1, n) }, async () => {
    for (;;) {
      const nx = it.next();
      if (nx.done) return;
      await fn(nx.value);
    }
  });
  await Promise.all(workers);
}

async function run() {
  const a = parseArgs(process.argv);
  fs.mkdirSync(DIR, { recursive: true });
  const state = a.rebuild ? { version: 1, updated: '', companies: {} } : loadState();

  log('巡回対象（watchlist）を構築中…');
  const watch = buildWatchlist(a);
  log(`watchlist ${watch.size}社（自社サイトあり ${[...watch.values()].filter((t) => t.url).length}社）`);
  if (!watch.size) { console.error('巡回対象が0社です。--sources で企業台帳CSVを指定してください。'); process.exit(1); }

  if (a.stats) {
    const cs = Object.values(state.companies || {});
    const crawled = cs.length;
    const dates = cs.map((c) => c.lastCrawled).filter(Boolean).sort();
    console.log(`[site-signals] 巡回済み ${crawled}/${watch.size}社（${(crawled / watch.size * 100).toFixed(1)}%）`);
    console.log(`[site-signals] 最終巡回 ${dates[dates.length - 1] || '—'} / 最古 ${dates[0] || '—'}`);
    console.log(`[site-signals] 指紋を保持 ${cs.filter((c) => c.fp && (c.fp.recruit || c.fp.news)).length}社（差分が出せる社数）`);
    return;
  }

  const targets = pickTargets(watch, state, a);
  const fresh = targets.filter((t) => !t.lastCrawled).length;
  log(`今回巡回 ${targets.length}社（初回 ${fresh}社 / 再訪 ${targets.length - fresh}社・並列${a.conc}）`);

  const today = ymd();
  const append = (obj) => fs.appendFileSync(JSONL, JSON.stringify(obj) + '\n', 'utf8');
  const audit = [];
  const tally = {};
  const rejected = {};
  let hit = 0, done = 0, errors = 0;

  await pool(targets, a.conc, async (t) => {
    const prev = state.companies[t.key] || null;
    const res = await crawlCompany(t, { maxPages: a.maxPages, asOf: today }).catch((e) => ({ error: String(e && e.message || e), signals: [], fp: {}, facts: {}, pages: [] }));
    done++;
    if (res.error && !res.pages.length) errors++;

    // 差分シグナル（前回の指紋との比較）。初回は必ず空になる＝2周目から効き始める。
    const diff = detectSiteDiffSignals(prev, res).map((s) => ({ ...s, source: '採用ページ', url: t.url || t.recruitUrl }));
    const signals = [...res.signals, ...diff];

    // 巡回状態を更新（本文は持たず指紋だけ。台帳が肥大しない）
    state.companies[t.key] = {
      name: t.name,
      url: t.url || t.recruitUrl,
      firstSeen: (prev && prev.firstSeen) || today,
      lastCrawled: today,
      lastSeen: today,
      crawls: ((prev && prev.crawls) || 0) + 1,
      fp: Object.keys(res.fp || {}).length ? res.fp : (prev && prev.fp) || {},
      lastSignals: signals.map((s) => s.key),
      pages: res.pages.length,
      error: res.error || '',
    };

    const reason = res.error ? `fetch-error(${String(res.error).slice(0, 40)})` : (res.rejected || 'no-signal');
    if (!signals.length) {
      rejected[reason] = (rejected[reason] || 0) + 1;
      audit.push({ source: '公式サイト巡回', url: t.url || t.recruitUrl, company: t.name, decision: 'reject', reason });
      return;
    }

    append({
      url: t.url || t.recruitUrl,
      title: `${t.name} 公式サイト巡回`,
      company: t.name,
      公式URL: t.url || '',
      採用ページURL: t.recruitUrl || '',
      業種: t.industry || '',
      都道府県: t.pref || '',
      電話番号: res.facts.電話番号 || t.phone || '',
      代表者名: '',
      採用担当者名: res.facts.採用担当者名 || '',
      担当役職: res.facts.担当役職 || '',
      従業員数: t.emp == null ? '' : String(t.emp),
      採用人数: t.hire == null ? '' : String(t.hire),
      date: today,
      signals,
      harvestedAt: today,
    });
    hit++;
    for (const s of signals) tally[s.key] = (tally[s.key] || 0) + 1;
    audit.push({ source: '公式サイト巡回', url: t.url || t.recruitUrl, company: t.name, decision: 'accept', signals: signals.map((s) => s.key) });
    if (hit % 25 === 0) log(`  シグナル検出 ${hit}社（巡回 ${done}/${targets.length}社）`);
  });

  saveState(state);
  appendAudit(audit);

  const crawledTotal = Object.keys(state.companies).length;
  console.log('\n─────────────────────────────────────────────');
  console.log('[site-signals] 自社ICP企業の定点観測');
  console.log('─────────────────────────────────────────────');
  console.log(`  巡回          ${done}社（取得失敗 ${errors}社）`);
  console.log(`  シグナル検出  ${hit}社（採択率 ${done ? (hit / done * 100).toFixed(1) : '0.0'}%）`);
  console.log(`  watchlist進捗 ${crawledTotal}/${watch.size}社（${(crawledTotal / watch.size * 100).toFixed(1)}%）`);
  console.log('\n  シグナル別');
  for (const [k, v] of Object.entries(tally).sort((x, y) => y[1] - x[1])) console.log(`    ${String(v).padStart(4)}社  ${k}`);
  console.log('\n  不採用の内訳');
  for (const [k, v] of Object.entries(rejected).sort((x, y) => y[1] - x[1]).slice(0, 12)) console.log(`    ${String(v).padStart(4)}社  ${k}`);
  console.log(`\n[site-signals] out: ${path.relative(ROOT, JSONL)}`);
  if (fresh === targets.length) console.log('[site-signals] ※ 今回は全社が初回巡回のため差分シグナルは0です。2周目から「採用ページ更新」が出ます。');
}

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildWatchlist, pickTargets, JSONL, STATE, MEDIA_HOST };
