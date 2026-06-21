'use strict';
// 観測層: 与えられたクエリ集合で新卒採用サイトを polite に巡回し、1サイクル分のスナップショットを作る。
//   社（正規化名）→ { 企業名, totalJobs, gradYears, sources:{媒体:{jobCount,jobs[],queries[]}} }
//
// 既定ソースは「求人ボックス」（静的HTMLで取得可・scrape-media で較正済）。
// 他媒体（リクナビ/マイナビ/ワンキャリア等）は CAPTURERS に adapter を足せば合流する。
// 全取得は polite.js 経由（robots遵守・ホスト別レート制限・キャッシュ）。
const cheerio = require('cheerio');
const { politeGet } = require('../polite');
const { normCompanyName } = require('../csv');
const { JOB_ENGINES } = require('../scrape-media');

// 監視用キャッシュTTL（既定30分）。polite既定の7日では同一クエリ再取得が常にキャッシュヒットし
// 変化検知できない（評価報告書Blocker①）。監視は短TTLで「再取得→差分」を成立させる。
const monMaxAge = () => parseInt(process.env.MONITOR_CACHE_TTL_MS || '1800000', 10) || 1800000;

// タイトル/スニペットから卒年を拾う（"2027年卒" "27卒" "2027" 等）
function extractGradYears(text) {
  const out = new Set();
  const re = /(20[2-9]\d)\s*年?卒|(?<![0-9])([2-9]\d)\s*年?卒/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (m[1]) out.add(m[1]);
    else if (m[2]) out.add('20' + m[2]);
  }
  return [...out];
}

// 掲載/更新の「真の鮮度」を日数で拾う（"新着""本日""3日前""2026/6/15"等）。最も新しい＝最小日数を返す。
// 全静的OK媒体(求人ボックス/リクナビ/キャリタス/就活会議…)に存在する事をプローブで実証済。観測初回NEXT≠真の新しさ問題を解消する信号。
function parseRecencyDays(text) {
  const t = String(text || '');
  let min = null;
  const upd = (d) => { if (d != null && d >= 0 && (min == null || d < min)) min = d; };
  if (/新着|本日|今日/.test(t)) upd(0);
  if (/昨日/.test(t)) upd(1);
  let m;
  const reRel = /(\d+)\s*(時間前|分前|日前|週間前|ヶ月前|か月前)/g;
  while ((m = reRel.exec(t)) !== null) {
    const n = parseInt(m[1], 10); const u = m[2];
    if (/時間前|分前/.test(u)) upd(0);
    else if (u === '日前') upd(n);
    else if (u === '週間前') upd(n * 7);
    else upd(n * 30);
  }
  // 絶対日付は直近120日以内のみ採用（それ以前は記事日等のノイズとみなす）
  const reAbs = /(20[2-9]\d)[\/.年\-](1[0-2]|0?[1-9])[\/.月\-]([0-3]?\d)/g;
  const now = Date.now();
  while ((m = reAbs.exec(t)) !== null) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const days = Math.floor((now - dt.getTime()) / 86400000);
    if (days >= 0 && days <= 120) upd(days);
  }
  return min;
}
const minRecency = (a, b) => (b == null ? a : (a == null ? b : Math.min(a, b)));

// 求人ボックスを cardSel 単位で読む観測器。adapter は scrape-media の JOB_ENGINES から流用。
function makeJobEngineCapturer(eng) {
  return async function capture(queries, { maxPagesPerQuery = 1, onWarn } = {}) {
    const companies = new Map();  // 正規化名 -> {企業名, jobCount, jobs:Set, queries:Set, gradYears:Set}
    let cardsSeen = 0;
    for (const q of queries) {
      for (let page = 1; page <= maxPagesPerQuery; page++) {
        const url = eng.searchUrl(q, page);
        const r = await politeGet(url, { render: 'static', maxAgeMs: monMaxAge() });
        if (!r || r.blocked || r.error || !r.html) {
          if (r && r.blocked && onWarn) onWarn(`[${eng.name}] robots不可: ${url}`);
          break;
        }
        const $ = cheerio.load(r.html);
        let pageCards = 0;
        $(eng.cardSel).each((_, card) => {
          const $c = $(card);
          let comp = '';
          for (const sel of eng.companySel) { const t = $c.find(sel).first().text().replace(/\s+/g, ' ').trim(); if (t) { comp = t; break; } }
          const key = normCompanyName(comp);
          if (!key) return;
          pageCards++;
          const title = eng.titleSel ? $c.find(eng.titleSel).first().text().replace(/\s+/g, ' ').trim() : '';
          if (!companies.has(key)) companies.set(key, { 企業名: comp, jobCount: 0, jobs: new Set(), queries: new Set(), gradYears: new Set(), recencyDays: null });
          const e = companies.get(key);
          e.jobCount++;
          if (title) e.jobs.add(title.slice(0, 40));
          e.queries.add(q);
          const ctext = $c.text();
          for (const y of extractGradYears(title + ' ' + ctext)) e.gradYears.add(y);
          e.recencyDays = minRecency(e.recencyDays, parseRecencyDays(ctext));
        });
        cardsSeen += pageCards;
        if (!pageCards) break; // これ以上ページが無い
      }
    }
    return { source: eng.name, companies, cardsSeen };
  };
}

// 企業一覧型の観測器（カード構造でなく企業名要素を直接列挙する媒体向け）。
// リクナビのようにCSS Modulesのハッシュ付きclassを使う媒体は、プレフィックス一致セレクタで頑健に拾う。
function makeCompanyListCapturer(ad) {
  return async function capture(queries, { onWarn } = {}) {
    const companies = new Map();
    let cardsSeen = 0;
    // fixedUrl: クエリで絞られない「最新一覧」型（キャリタス等）。1回だけ取得し、職種を含まない
    // 中立クエリ'新卒'で帰属する（職種不明なので営業等のICP加点を誤って与えない）。
    // それ以外: クエリ毎に検索。同一URLは1サイクル内で重複取得しない（dedupe）。
    const tasks = ad.fixedUrl ? [{ url: ad.searchUrl(), q: '新卒' }] : queries.map((q) => ({ url: ad.searchUrl(q), q }));
    const fetched = new Set();
    for (const { url, q } of tasks) {
      if (fetched.has(url)) continue;
      fetched.add(url);
      const r = await politeGet(url, { render: 'static', maxAgeMs: monMaxAge() });
      if (!r || r.blocked || r.error || !r.html) {
        if (r && r.blocked && onWarn) onWarn(`[${ad.name}] robots不可: ${url}`);
        continue;
      }
      const $ = cheerio.load(r.html);
      $(ad.companySel).each((_, el) => {
        const comp = $(el).text().replace(/\s+/g, ' ').trim();
        const key = normCompanyName(comp);
        if (!key || comp.length > 60) return;
        cardsSeen++;
        if (!companies.has(key)) companies.set(key, { 企業名: comp, jobCount: 0, jobs: new Set(), queries: new Set(), gradYears: new Set(), recencyDays: null });
        const e = companies.get(key);
        e.jobCount++;
        e.queries.add(q);
        // カード境界は媒体で深さが違う（キャリタスは社名から4階層上）。cardSel指定があれば closest、
        // 無ければ最大4階層上を「カード近傍」として走査し、掲載日/卒年/エントリー状態を拾う。
        let card = ad.cardSel ? $(el).closest(ad.cardSel) : $(el);
        if (!ad.cardSel) { for (let up = 0; up < 4; up++) card = card.parent(); }
        const near = (card.length ? card : $(el)).text().slice(0, 600);
        for (const y of extractGradYears(near)) e.gradYears.add(y);
        e.recencyDays = minRecency(e.recencyDays, parseRecencyDays(near));
      });
    }
    return { source: ad.name, companies, cardsSeen };
  };
}

// 企業一覧型 媒体adapter（実地プローブで較正済 2026-06）。
const LIST_ADAPTERS = [
  {
    name: 'リクナビ',
    // /27/ は404、/2027/ search が正（実証）。社名はCSS Modulesハッシュ付きclassなのでプレフィックス一致で頑健化。
    searchUrl: (q) => `https://job.rikunabi.com/2027/search/?kw=${encodeURIComponent(q)}`,
    companySel: '[class*="companyName__"]',
  },
  {
    name: 'キャリタス就活',
    // discover-endpoint で特定: /employment-search/ が掲載日付きの企業一覧（鮮度マーカーあり実証）。
    // キーワード非対応のため最新一覧を定点観測（新規企業の出現＋エントリー状態で鮮度判定）。
    fixedUrl: true, // クエリ非依存→1回取得・中立クエリ帰属（誤ったICP職種加点を防ぐ）
    searchUrl: () => 'https://job.career-tasu.jp/employment-search/',
    companySel: '.c_panelCompanyInfoMain__ttl',
  },
];

// 既定の観測器セット = ジョブエンジン（求人ボックス）＋ 企業一覧型（リクナビ）。
// 観測網を絞りたい場合は MONITOR_SOURCES（カンマ区切りの媒体名）で限定。
const ALL_CAPTURERS = [
  ...JOB_ENGINES.map((eng) => ({ name: eng.name, capture: makeJobEngineCapturer(eng) })),
  ...LIST_ADAPTERS.map((ad) => ({ name: ad.name, capture: makeCompanyListCapturer(ad) })),
];
const ONLY = (process.env.MONITOR_SOURCES || '').split(',').map((s) => s.trim()).filter(Boolean);
const CAPTURERS = ONLY.length ? ALL_CAPTURERS.filter((c) => ONLY.includes(c.name)) : ALL_CAPTURERS;

// 1サイクル分のスナップショットを作る。
// 戻り値: { cycle, companies:{key:{企業名,totalJobs,gradYears,sources}}, stats:{source:{cards,companies},staleSources[]} }
async function captureSnapshot(queries, { cycle, maxPagesPerQuery = 1, capturers = CAPTURERS, onWarn = () => {} } = {}) {
  const merged = {};      // key -> company state
  const stats = { perSource: {}, staleSources: [] };
  for (const cap of capturers) {
    const { source, companies, cardsSeen } = await cap.capture(queries, { maxPagesPerQuery, onWarn });
    stats.perSource[source] = { cards: cardsSeen, companies: companies.size };
    // 全クエリで0件＝セレクタ劣化(DOM変更)の疑い。自律ブレインが拾う。
    if (cardsSeen === 0) { stats.staleSources.push(source); onWarn(`[${source}] 0件: セレクタ劣化の疑い`); }
    for (const [key, e] of companies) {
      if (!merged[key]) merged[key] = { 企業名: e.企業名, totalJobs: 0, gradYears: new Set(), recencyDays: null, sources: {} };
      const c = merged[key];
      c.sources[source] = { jobCount: e.jobCount, jobs: [...e.jobs], queries: [...e.queries], recencyDays: e.recencyDays };
      c.totalJobs += e.jobCount;
      for (const y of e.gradYears) c.gradYears.add(y);
      c.recencyDays = minRecency(c.recencyDays, e.recencyDays);
    }
  }
  // Set を配列に固める
  const companies = {};
  for (const [key, c] of Object.entries(merged)) {
    companies[key] = { 企業名: c.企業名, totalJobs: c.totalJobs, gradYears: [...c.gradYears].sort(), recencyDays: c.recencyDays, sources: c.sources };
  }
  return { cycle, companies, stats };
}

module.exports = { captureSnapshot, extractGradYears, parseRecencyDays, makeJobEngineCapturer, makeCompanyListCapturer, LIST_ADAPTERS, CAPTURERS };
