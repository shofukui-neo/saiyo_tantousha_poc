'use strict';
/**
 * 媒体の巡回設定を自動で見つける（企業詳細ページのURLの型・一覧ページ・サイトマップ）
 * =====================================================================
 * 媒体ごとに手で抽出器を書くと110本になる。そこで構造の共通点だけを使う:
 *   「企業詳細ページへのリンクは、アンカーが法人格つきの社名で、URLは同じ型（/company/123/ 等）」
 * 一覧ページの内部リンクのうちアンカーが社名のものを集め、パスのID部分を伏せた型で数える。
 * 3件以上の異なるURLが同じ型に乗れば、それを企業詳細の型として採用する。
 *
 * learnDetailPattern / internalLinks / parseSitemap は純関数（テスト対象）。
 */
const zlib = require('zlib');
const cheerio = require('cheerio');
const { politeGet } = require('../polite');
const { downloadFile } = require('./download');
const fs = require('fs');

const COMPANY_NAME_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|（株）|\(株\)|㈱|㈲|医療法人|社会福祉法人|学校法人|協同組合|一般社団法人|一般財団法人|公益社団法人|公益財団法人|農業協同組合)/;
const LISTING_HINT = /(company|companies|corp|kigyo|kaisha|会社|企業|一覧|list|search|result|area|pref|地域|業種|industry|category|page=|p=|recruit|job|member|参加|掲載|shinsotsu|新卒|\d{2}卒)/i;
const SKIP_PATH = /(login|signin|signup|register|entry|mypage|favorite|bookmark|logout|cart|inquiry|contact|privacy|terms|kiyaku|policy|sitemap|\.pdf$|\.jpe?g$|\.png$|\.gif$|\.zip$)/i;
const ID_SEG = /^(?:\d+|[0-9a-f]{8,}|[A-Za-z]{0,6}\d[\w-]*|[\w-]*\d{3,}[\w-]*)$/;

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } };
const sameSite = (a, b) => { const x = hostOf(a), y = hostOf(b); return x && y && (x === y || x.endsWith('.' + y) || y.endsWith('.' + x)); };

/** URL を「型」にする: パスのID部分を :id に、クエリは値を伏せてキーだけ残す。 */
function templateOf(url) {
  let u; try { u = new URL(url); } catch { return ''; }
  const segs = u.pathname.split('/').map((s) => (s && ID_SEG.test(decodeURIComponent(s)) ? ':id' : s));
  const keys = [...u.searchParams.keys()].sort();
  return segs.join('/') + (keys.length ? '?' + keys.join('&') : '');
}

/** 型 → URL を判定する正規表現の文字列（pathname+search に当てる）。 */
function templateToRegex(tpl) {
  const [p, q] = tpl.split('?');
  const esc = (s) => s.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
  const path = p.split('/').map((s) => (s === ':id' ? '[^/?]+' : esc(s))).join('/');
  const query = q ? '\\?' + q.split('&').map((k) => `(?=.*\\b${esc(k)}=)`).join('') + '.*' : '';
  return `^${path}${query}$`;
}

/** HTMLから同一サイト内のリンクを {url, text} で返す（純関数）。 */
function internalLinks(html, baseUrl) {
  const $ = cheerio.load(html || '');
  const out = [];
  const seen = new Set();
  $('a[href]').each((_, a) => {
    let abs; try { abs = new URL($(a).attr('href'), baseUrl).href.replace(/#.*$/, ''); } catch { return; }
    if (!/^https?:/.test(abs) || !sameSite(abs, baseUrl) || SKIP_PATH.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    const text = ($(a).attr('title') || $(a).text() || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push({ url: abs, text });
  });
  return out;
}

/**
 * 社名アンカーのリンク群から企業詳細の型を学習する（純関数）。
 * @param {{url:string,text:string}[]} links
 * @returns {{template:string, regex:string, support:number}|null}
 */
function learnDetailPattern(links, minSupport = 3) {
  const byTpl = new Map();
  for (const l of links) {
    if (!COMPANY_NAME_RE.test(l.text)) continue;
    const t = templateOf(l.url);
    if (!t || !t.includes(':id') && !t.includes('?')) continue; // 型にIDが無いもの（/about/ 等）は詳細ではない
    if (!byTpl.has(t)) byTpl.set(t, new Set());
    byTpl.get(t).add(l.url);
  }
  const ranked = [...byTpl.entries()].filter(([, set]) => set.size >= minSupport)
    .map(([t, set]) => ({ t, n: set.size, score: set.size * pathWeight(t) }))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  return { template: ranked[0].t, regex: templateToRegex(ranked[0].t), support: ranked[0].n };
}

// 型の重み。企業ページらしいパスを優先し、先輩紹介・記事・イベントのページ（社名は出るが企業詳細ではない）を下げる。
const COMPANY_PATH = /(compan|corp|kigyo|kaisha|client|employer|enterprise|firm|shop|baseinfo|outline|profile)/i;
const NOT_COMPANY_PATH = /(interview|introduction|staff|senpai|voice|person|people|member|blog|news|article|column|event|seminar|topic|feature|special|report|movie|video)/i;
function pathWeight(tpl) { return (COMPANY_PATH.test(tpl) ? 3 : 1) * (NOT_COMPANY_PATH.test(tpl) ? 0.2 : 1); }

/**
 * サイトマップのURL群を型ごとに数え、多い順に候補を返す（純関数）。
 * 一覧が JS 検索で巡回できない媒体（マイナビ・あさがくナビ等）は、ここから企業詳細の型を見つける。
 */
function rankSitemapTemplates(urls, { minCount = 20, top = 4 } = {}) {
  const byTpl = new Map();
  for (const u of urls) {
    const t = templateOf(u);
    if (!t || !t.includes(':id')) continue;
    if (!byTpl.has(t)) byTpl.set(t, []);
    byTpl.get(t).push(u);
  }
  return [...byTpl.entries()].filter(([, us]) => us.length >= minCount)
    .map(([t, us]) => ({ template: t, regex: templateToRegex(t), count: us.length, samples: us.slice(0, 2), score: us.length * pathWeight(t) }))
    .sort((a, b) => b.score - a.score).slice(0, top);
}

const matchesDetail = (url, regex) => { try { const u = new URL(url); return new RegExp(regex).test(u.pathname + u.search); } catch { return false; } };

/** sitemap XML から <loc> を取り出す（純関数）。index か urlset かも返す。 */
function parseSitemap(xml) {
  const locs = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(m[1].trim().replace(/&amp;/g, '&'));
  return { isIndex: /<sitemapindex/i.test(xml), locs };
}

async function fetchSitemap(url, sourceId) {
  if (/\.gz($|\?)/i.test(url)) {
    const f = await downloadFile(url, { sourceId, maxAgeDays: 7 });
    return zlib.gunzipSync(fs.readFileSync(f.path)).toString('utf8');
  }
  const r = await politeGet(url, { text: true });
  return r && r.body ? r.body : '';
}

/** robots.txt の Sitemap 宣言＋/sitemap.xml から、型に合うURL（regex=null なら全部）を最大 limit 件集める。 */
async function sitemapDetailUrls(topUrl, regex, { sourceId, limit = 5000, maxFiles = 40 } = {}) {
  const origin = new URL(topUrl).origin;
  const roots = [];
  const robots = await politeGet(origin + '/robots.txt', { text: true });
  if (robots && robots.body) for (const m of robots.body.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) roots.push(m[1]);
  if (!roots.length) roots.push(origin + '/sitemap.xml');
  const queue = [...new Set(roots)];
  const seen = new Set();
  const out = new Set();
  while (queue.length && seen.size < maxFiles && out.size < limit) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let xml = '';
    try { xml = await fetchSitemap(sm, sourceId); } catch { continue; }
    const { isIndex, locs } = parseSitemap(xml);
    if (isIndex) {
      // 企業っぽい名前の子サイトマップを先に辿る
      locs.sort((a, b) => Number(/compan|corp|kigyo|client|recruit|job/i.test(b)) - Number(/compan|corp|kigyo|client|recruit|job/i.test(a)));
      queue.push(...locs);
    } else {
      for (const u of locs) if (sameSite(u, topUrl) && (!regex || matchesDetail(u, regex))) out.add(u);
    }
  }
  return [...out].slice(0, limit);
}

/**
 * 一覧ページを幅優先で巡回し、企業詳細の型に合うリンク（アンカーの社名つき）を集める。
 * @returns {Promise<{details:Map<string,string>, listPages:string[], pattern:object|null}>}
 */
async function crawlListings(startUrls, { regex = null, render = 'static', maxListPages = 30, maxDetails = 5000 } = {}) {
  const queue = [...startUrls];
  const visited = new Set();
  const details = new Map(); // url -> アンカーの社名
  const links = [];
  let pattern = regex ? { regex } : null;
  while (queue.length && visited.size < maxListPages && details.size < maxDetails) {
    const u = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    const r = await politeGet(u, { render });
    if (!r || !r.html) continue;
    const ls = internalLinks(r.html, r.finalUrl || u);
    links.push(...ls);
    let scan = ls;
    if (!pattern) {
      pattern = learnDetailPattern(links);
      if (pattern) scan = links; // 型が今わかったら、これまでのページのリンクも拾い直す
    }
    for (const l of scan) {
      if (pattern && matchesDetail(l.url, pattern.regex)) {
        if (!details.has(l.url) && COMPANY_NAME_RE.test(l.text)) details.set(l.url, l.text);
        else if (!details.has(l.url)) details.set(l.url, '');
      } else if (LISTING_HINT.test(new URL(l.url).pathname + new URL(l.url).search) && !visited.has(l.url) && queue.length < maxListPages * 5) {
        queue.push(l.url);
      }
    }
  }
  if (!pattern) pattern = learnDetailPattern(links);
  return { details, listPages: [...visited], pattern };
}

module.exports = {
  COMPANY_NAME_RE, templateOf, templateToRegex, internalLinks, learnDetailPattern, matchesDetail,
  parseSitemap, sitemapDetailUrls, rankSitemapTemplates, crawlListings, sameSite, hostOf,
};
