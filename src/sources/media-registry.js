'use strict';
/**
 * 媒体カタログ（新卒媒体 約110）を登録簿に載せる層
 * =====================================================================
 *   src/sources/media.json … 媒体ごとの判定と巡回設定（git 管理。data/media-catalog.json から同期）
 *
 * 1媒体＝登録簿の1ソース（id は m-<ホスト名>）。状態は次のどれか:
 *   active     … 規約に禁止なし・robots 許可・企業詳細の型を学習でき、試し抽出が通った → 収集できる
 *   unverified … 規約ページが見つからない／企業詳細の型が見つからない等。理由つきで人の確認待ち
 *   excluded   … 規約で禁止・robots 不可・ログイン壁・ICP外（IT特化）・URL未確定
 *   planned    … まだプローブしていない
 *
 * 規約の自動判定を人が覆すときは tos_override に { legal_tier, reason, by, at } を書く（判定より優先）。
 */
const fs = require('fs');
const path = require('path');
const { politeGet } = require('../polite');
const { checkTerms } = require('./media-tos');
const { crawlListings, sitemapDetailUrls, rankSitemapTemplates, templateOf, templateToRegex } = require('./media-discover');
const { extractDetail } = require('./media-extract');

const MEDIA_FILE = path.join(__dirname, 'media.json');
const CATALOG = path.resolve(__dirname, '..', '..', 'data', 'media-catalog.json');
const ymd = () => new Date().toISOString().slice(0, 10);

function load() {
  if (!fs.existsSync(MEDIA_FILE)) return { media: [] };
  return JSON.parse(fs.readFileSync(MEDIA_FILE, 'utf8'));
}
/** 指定した媒体だけをディスク上の最新に上書きする（並行して人が編集した他の媒体を消さない）。 */
function saveMedia(changed) {
  const doc = load();
  const byName = new Map(changed.map((m) => [m.name, m]));
  doc.media = doc.media.map((m) => byName.get(m.name) || m);
  save(doc);
}
function save(doc) {
  const tmp = MEDIA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, MEDIA_FILE);
}

/** 媒体URLから登録簿のIDを作る。同じホストが2つあればパスの先頭も付ける。 */
function idOf(url, taken) {
  let u; try { u = new URL(url); } catch { return ''; }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  let id = 'm-' + host.replace(/[^a-z0-9]+/g, '-');
  const seg = u.pathname.split('/').filter(Boolean)[0];
  if (taken.has(id) && seg) id += '-' + seg.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return id;
}

/** 静的に決まる除外（プローブ前に判定できるもの）。 */
function staticExclusion(m) {
  if (m.exclude_reason) return m.exclude_reason; // 人が調べて決めた除外（URL調査の結果など）
  if (!m.url) return 'URL未確定（カタログにURLが無い）';
  if (/IT特化/.test(m.cat)) return 'ICPのIT除外（IT特化媒体）';
  if (m.catalog_strategy === 'blocked-or-login') return 'ログイン壁・公開の企業ページなし（カタログの実測判定）';
  return '';
}

/**
 * data/media-catalog.json から media.json を同期する。既存の判定・設定は残し、新しい媒体だけ足す。
 * @returns {{added:number, total:number}}
 */
function syncFromCatalog() {
  const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const doc = load();
  const byName = new Map(doc.media.map((m) => [m.name, m]));
  const taken = new Set(doc.media.map((m) => m.id).filter(Boolean));
  let added = 0;
  for (const c of cat.media) {
    let m = byName.get(c.name);
    if (!m) {
      m = { id: '', name: c.name, status: 'planned' };
      doc.media.push(m);
      added++;
    }
    Object.assign(m, { cat: c.cat, role: c.role, url: m.url_override || c.url || '', catalog_strategy: c.strategy, catalog_note: c.note || '', catalog_probe: c.probe || null });
    if (!m.id) { m.id = idOf(m.url, taken) || `m-unknown-${added}`; taken.add(m.id); }
    const ex = staticExclusion(m);
    if (ex) Object.assign(m, { status: 'excluded', reason: ex, legal_tier: m.legal_tier || (/ログイン/.test(ex) ? 'T3' : 'T2') });
  }
  save(doc);
  return { added, total: doc.media.length };
}

/** media.json の1媒体 → 登録簿の1ソース。 */
function toEntry(m) {
  const tier = (m.tos_override && m.tos_override.legal_tier) || m.legal_tier || 'T2';
  const runnable = m.status === 'active' && tier !== 'T3';
  return {
    id: m.id, name: `${m.name}（新卒媒体・${m.cat}）`, group: 'C', legal_tier: tier,
    tos_checked_at: m.tos_checked_at || null, tos_url: m.tos_url || '', tos_note: m.reason || '',
    method: 'list-crawl', cadence: 'weekly', fields: ['社', '採', '電', '名'], reliability: 0.9,
    icp_prior: /地方特化|医療福祉|体育会|高卒/.test(m.cat) ? '◎' : '○',
    adapter: runnable ? 'media' : null, status: runnable ? 'active' : m.status, note: m.reason || '', media: m,
  };
}

function entries() { return load().media.filter((m) => m.id).map(toEntry); }

/**
 * 1媒体をプローブして、規約・robots・巡回設定・試し抽出の結果を m に書き込む（ネットワークあり）。
 * @param {object} m media.json の1媒体（その場で書き換える）
 */
async function probeMedia(m, log = () => {}) {
  Object.assign(m, { probed_at: ymd(), status: 'planned', reason: '' }); // 前回の判定を持ち越さない
  const ex = staticExclusion(m);
  if (ex) { Object.assign(m, { status: 'excluded', reason: ex }); return m; }

  const top = await politeGet(m.url, { render: 'static' });
  if (top && top.blocked) { Object.assign(m, { status: 'excluded', legal_tier: 'T3', robots: 'disallow', reason: 'robots.txt でトップが不可' }); return m; }
  // 正直なUAを 403/401 で弾く媒体は、回避せず収集しない（UA偽装・ボット回避はしない方針）
  if (top && /HTTP 40[13]/.test(top.error || '')) { Object.assign(m, { status: 'excluded', robots: '', reason: `自動アクセスを拒否（${top.error}）。UA偽装等の回避はしない` }); return m; }
  if (!top || !top.html) { Object.assign(m, { status: 'unverified', robots: '', reason: `到達不可（${(top && top.error) || 'no-html'}）。一時的な障害か社内網から届かない可能性。再プローブで確認` }); return m; }
  m.robots = 'allow';

  // 1) 利用規約
  const tos = await checkTerms(top.finalUrl || m.url, top.html);
  Object.assign(m, { tos_verdict: tos.verdict, tos_url: tos.terms_url, tos_evidence: tos.evidence });
  if (tos.verdict === 'no-explicit-prohibition') Object.assign(m, { legal_tier: 'T2', tos_checked_at: ymd() });
  if (tos.verdict === 'prohibited') Object.assign(m, { legal_tier: 'T3', tos_checked_at: ymd() });
  const override = m.tos_override && m.tos_override.legal_tier;
  const tier = override || m.legal_tier;
  if (tier === 'T3') {
    Object.assign(m, { status: 'excluded', reason: override ? `規約: 人の判断でT3（${m.tos_override.reason}）` : `規約で禁止（${tos.evidence.map((e) => e.kind).join('・')}）` });
    return m;
  }
  // 規約が未確認でも、巡回設定の学習までは進めておく（確認後すぐ収集できるように）
  const tosPending = !override && tos.verdict === 'not-found';
  const why = [];
  if (tosPending) why.push('利用規約のページが見つからない（人が確認して tos_override を書く）');
  if (override) m.tos_checked_at = m.tos_override.at || ymd();

  // 2) 企業詳細の型を学習し、試し抽出が通った候補を採る。
  //    一覧の静的巡回 → サイトマップ（一覧がJS検索の媒体）→ 一覧のJS描画 の順に試す。
  const start = top.finalUrl || m.url;
  const tryExtract = async (pairs, render) => {
    const got = [];
    for (const [url, anchorName] of pairs.slice(0, 4)) {
      const r = await politeGet(url, { render });
      const o = r && r.html ? extractDetail(r.html, url, { anchorName, mediaName: m.name }) : null;
      if (o) got.push({ url, name: o.company_name, phone: o.phone, employees: o.employees, hire: o.hire_newgrad, site: o.url });
    }
    return got;
  };
  const tried = [];
  let chosen = null;

  // 0) 人が教えた企業ページの例（detail_examples）があれば、その型を最優先で使う
  const examples = [].concat(m.detail_examples || []).filter(Boolean);
  if (examples.length) {
    const tpl = templateOf(examples[0]);
    const regex = templateToRegex(tpl);
    const crawl = await crawlListings([start], { regex, render: 'static', maxListPages: 20 });
    let pairs = [...crawl.details.entries()];
    let render = 'static';
    if (pairs.length < 3) {
      const smu = await sitemapDetailUrls(m.url, regex, { sourceId: m.id, limit: 2000, maxFiles: 20 }).catch(() => []);
      pairs = [...new Map([...pairs, ...smu.map((u) => [u, ''])]).entries()];
    }
    if (pairs.length < 3) {
      const js = await crawlListings([start], { regex, render: 'auto', maxListPages: 8 });
      if (js.details.size > pairs.length) { pairs = [...js.details.entries()]; render = 'auto'; }
    }
    pairs = [...new Map([...examples.map((u) => [u, '']), ...pairs]).entries()];
    let got = await tryExtract(pairs, render);
    if (got.length < 2 && render === 'static') { got = await tryExtract(pairs, 'auto'); render = 'auto'; }
    tried.push(`人が教えた例 ${tpl} 候補${pairs.length}件 抽出${got.length}/4`);
    if (got.length >= 2) chosen = { via: pairs.length > crawl.details.size + examples.length ? 'sitemap' : 'listing', render, pattern: { template: tpl, regex, support: pairs.length }, listPages: crawl.listPages, seen: pairs.length, got };
  }

  const listing = chosen ? { pattern: null } : await crawlListings([start], { render: 'static', maxListPages: 12 });
  if (listing.pattern) {
    const got = await tryExtract([...listing.details.entries()], 'static');
    tried.push(`一覧(静的) ${listing.pattern.template} 抽出${got.length}/4`);
    if (got.length >= 2) chosen = { via: 'listing', render: 'static', pattern: listing.pattern, listPages: listing.listPages, seen: listing.details.size, got };
  }
  if (!chosen) {
    const all = await sitemapDetailUrls(m.url, null, { sourceId: m.id, limit: 20000, maxFiles: 12 }).catch(() => []);
    for (const cand of rankSitemapTemplates(all)) {
      const got = await tryExtract(cand.samples.map((u) => [u, '']), 'static');
      tried.push(`サイトマップ ${cand.template}(${cand.count}件) 抽出${got.length}/2`);
      if (got.length >= 2) { chosen = { via: 'sitemap', render: 'static', pattern: { template: cand.template, regex: cand.regex, support: cand.count }, listPages: [], seen: cand.count, got }; break; }
    }
  }
  if (!chosen) {
    const js = await crawlListings([start], { render: 'auto', maxListPages: 6 });
    if (js.pattern) {
      const got = await tryExtract([...js.details.entries()], 'auto');
      tried.push(`一覧(JS描画) ${js.pattern.template} 抽出${got.length}/4`);
      if (got.length >= 2) chosen = { via: 'listing', render: 'auto', pattern: js.pattern, listPages: js.listPages, seen: js.details.size, got };
    }
  }
  if (!chosen) {
    why.push(`企業詳細ページの型が見つからない（${tried.length ? tried.join(' / ') : '一覧・サイトマップとも社名つきの詳細リンクなし'}）`);
    Object.assign(m, { crawl: { tried }, status: 'unverified', reason: why.join(' ／ ') });
    return m;
  }

  const sm = chosen.via === 'sitemap' ? chosen.seen
    : (await sitemapDetailUrls(m.url, chosen.pattern.regex, { sourceId: m.id, limit: 200, maxFiles: 6 }).catch(() => [])).length;
  m.crawl = {
    via: chosen.via, render: chosen.render, detail_template: chosen.pattern.template, detail_regex: chosen.pattern.regex,
    support: chosen.pattern.support, list_urls: chosen.listPages.slice(0, 20), sitemap_hits: sm, details_seen: chosen.seen,
    sample: chosen.got, tried,
  };
  Object.assign(m, why.length ? { status: 'unverified', reason: why.join(' ／ ') } : { status: 'active', reason: '' });
  log(`${m.name}: ${m.status} 型=${chosen.pattern.template}（${chosen.via}/${chosen.render}）詳細${chosen.seen}件 sitemap${sm}件`);
  return m;
}

module.exports = { MEDIA_FILE, load, save, saveMedia, syncFromCatalog, toEntry, entries, probeMedia, staticExclusion, idOf };
