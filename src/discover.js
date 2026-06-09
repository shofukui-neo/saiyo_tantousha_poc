'use strict';
// 企業名そのものを自動収集する「発見層」。外部AI API不使用。
// 起点は2通り：①キーワード（業種・地域など）でBing検索 → 結果＋上位ページから企業名を抽出
//             ②企業一覧ページのURL → そのページの構造要素から企業名を抽出
//
// 日本語の連続文（スペース無し）から正規表現だけで社名を切り出すのは過剰一致しやすいため、
// (a) HTMLの構造要素（リンク文言・見出し・リスト項目・セル等）の「短いテキスト」を対象にし、
// (b) 区切り文字でセグメント化したうえで法人格の前後関係から核を一意に決め、助詞の取り込みを除去する。
const cheerio = require('cheerio');
const cfg = require('./config');
const { bingSearch, companyCore } = require('./search');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTITY = '株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|医療法人|学校法人|社会福祉法人|特定非営利活動法人';
// 社名に使える文字（漢字/かな/カナ/英数(半角全角)/一部記号）。これ以外は社名の境界。
const NC = "0-9A-Za-zＡ-Ｚａ-ｚ０-９\\u3040-\\u309f\\u30a0-\\u30ff\\u4e00-\\u9fa5々ヶ・ー&'’\\-";
const ENTITY_RE = new RegExp(`(?:${ENTITY})`, 'g');
const SPLIT_RE = new RegExp(`[^${NC}]+`);          // セグメント分割（社名文字以外で割る）

function isNameChar(ch) { return ch !== undefined && new RegExp(`[${NC}]`).test(ch); }
function isHira(ch) { return ch !== undefined && ch >= '぀' && ch <= 'ゟ'; }

// 後置形「〈核〉株式会社」の核は、ブランド名が「最後の文法ひらがなの直後」から始まる傾向を使って先頭の文章部分を落とす。
//   例: 「…お問い合わせサイボウズ」→「サイボウズ」 / 「…ご紹介するサイトお問い合わせＳｋｙ」→「Ｓｋｙ」
function trimSuffixCore(s) {
  let start = 0;
  for (let i = 1; i < s.length; i++) if (isHira(s[i - 1]) && !isHira(s[i])) start = i;
  return s.slice(start);
}
// 前置形「株式会社〈核〉」の核は、末尾の文法ひらがな（助詞・活用）を落とす。
//   例: 「メルカリは上場」→「メルカリ」。ひらがな始まり（助詞句）は不採用。
function trimPrefixCore(s) {
  if (!s || isHira(s[0])) return '';
  let end = s.length;
  for (let i = 1; i < s.length; i++) if (!isHira(s[i - 1]) && isHira(s[i])) { end = i; break; }
  return s.slice(0, end);
}

// 全角英数を半角へ寄せて正規化（社名の表記ゆれ吸収）
function toHalfAlnum(s) {
  return String(s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 1セグメント（社名文字の連続）から企業名を取り出す。
function namesFromSegment(seg, out, seen) {
  if (!seg || seg.length > 40) return;             // 長すぎるセグメント＝文章の可能性が高く誤抽出の元
  let m;
  ENTITY_RE.lastIndex = 0;
  const ents = [];
  while ((m = ENTITY_RE.exec(seg)) !== null) ents.push({ idx: m.index, str: m[0], end: m.index + m[0].length });
  for (let k = 0; k < ents.length; k++) {
    const e = ents[k];
    const prevEnd = k > 0 ? ents[k - 1].end : 0;
    const nextStart = k < ents.length - 1 ? ents[k + 1].idx : seg.length;
    let name = '';
    if (e.idx > prevEnd && isNameChar(seg[e.idx - 1])) {
      // 後置形「〈核〉株式会社」：法人格の直前の核（先頭の文章部分を除去）
      const core = trimSuffixCore(seg.slice(prevEnd, e.idx));
      if (!core) continue;
      name = core + e.str;
    } else {
      // 前置形「株式会社〈核〉」：法人格の直後の核（末尾の助詞・活用を除去）
      const core = trimPrefixCore(seg.slice(e.end, nextStart));
      if (!core) continue;
      if (/^[぀-ゟ]{1,2}$/.test(core)) continue;
      name = e.str + core;
    }
    pushName(name, out, seen);
  }
}

function pushName(raw, out, seen) {
  let n = toHalfAlnum(String(raw || '').trim()).replace(/^[・\-'’&]+/, '').replace(/[・\-'’&]+$/, '').trim();
  if (!new RegExp(`(?:${ENTITY})`).test(n)) return;
  const core = companyCore(n);
  if (!core || core.length < 1 || core.length > 24) return;
  if (/^[぀-ゟ]{1,2}$/.test(core)) return;
  const key = core.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(n);
}

/**
 * プレーンテキストから企業名を抽出（タイトル/スニペット等の短文向け）。純ロジック。
 * @param {string} text
 * @returns {string[]}
 */
function extractCompanyNames(text) {
  const out = []; const seen = new Set();
  for (const seg of String(text || '').split(SPLIT_RE)) namesFromSegment(seg, out, seen);
  return out;
}

/**
 * HTMLの構造要素（リンク/見出し/リスト/セル等）の短いテキストから企業名を抽出。
 * 連続文の塊を避けられるため、一覧ページ・まとめ記事に強い。
 * @param {string} html
 * @returns {string[]}
 */
function extractCompanyNamesFromHtml(html) {
  const out = []; const seen = new Set();
  if (!html) return out;
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,iframe,head').remove();
  $('a, h1, h2, h3, h4, li, td, th, dt, dd, strong, b, caption, figcaption').each((_, el) => {
    const t = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40) return;
    for (const seg of t.split(SPLIT_RE)) namesFromSegment(seg, out, seen);
  });
  return out;
}

/**
 * キーワード（業種・地域など）で企業名を収集。Bing検索の結果＋上位ページ本文から抽出。
 */
async function discoverFromQuery(query, deps = {}, opt = {}) {
  const limit = opt.limit || cfg.DISCOVER_LIMIT;
  const pages = opt.pages || cfg.DISCOVER_PAGES;
  const out = []; const seen = new Set();
  const add = (name) => { const key = companyCore(name).toLowerCase(); if (key && !seen.has(key)) { seen.add(key); out.push(name); } };
  const q = /企業|会社|一覧|株式会社|おすすめ/.test(query) ? query : `${query} 企業 一覧`;

  for (let p = 0; p < pages && out.length < limit; p++) {
    let candidates = [];
    try { candidates = await bingSearch(q, p * 10 + 1); } catch (_) { break; }
    // (1) まず検索結果のタイトル/スニペットから
    for (const c of candidates) extractCompanyNames(`${c.title} ${c.snippet}`).forEach(add);
    // (2) 上位の結果ページ本文（まとめ記事・一覧ページ）からも抽出
    if (deps.fetchPage && deps.extractText) {
      for (const c of candidates.slice(0, cfg.DISCOVER_FETCH_TOP)) {
        if (out.length >= limit) break;
        try {
          const page = await deps.fetchPage(c.url);
          extractCompanyNamesFromHtml(page.html || '').forEach(add);
        } catch (_) { /* skip */ }
        await sleep(cfg.POLITE_DELAY_MS);
      }
    }
    await sleep(cfg.SEARCH_DELAY_MS);
  }
  return out.slice(0, limit);
}

/**
 * 企業一覧ページのURLから企業名を抽出。
 */
async function discoverFromListUrl(url, deps, opt = {}) {
  const limit = opt.limit || cfg.DISCOVER_LIMIT;
  const page = await deps.fetchPage(url);
  return extractCompanyNamesFromHtml(page.html || '').slice(0, limit);
}

/**
 * 起点（query か listUrl）から企業名リストを収集する統合関数。
 */
async function discoverCompanies(opts = {}, deps = {}) {
  if (opts.listUrl) {
    const names = await discoverFromListUrl(opts.listUrl, deps, opts);
    return { names, source: 'list-url' };
  }
  if (opts.query) {
    const names = await discoverFromQuery(opts.query, deps, opts);
    return { names, source: 'keyword-search' };
  }
  return { names: [], source: 'none' };
}

module.exports = {
  discoverCompanies, discoverFromQuery, discoverFromListUrl,
  extractCompanyNames, extractCompanyNamesFromHtml,
};
