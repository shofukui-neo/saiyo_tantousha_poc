'use strict';
const cheerio = require('cheerio');
const { USER_AGENT, PER_PAGE_TIMEOUT_MS, MAX_TEXT_CHARS, PAGE_HINTS, STRONG_HINTS } = require('./config');

// ---- 軽量HTTP取得（まずこれを試す） ----
async function fetchStatic(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja,en;q=0.8' },
      signal: ctrl.signal, redirect: 'follow',
    });
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!/text\/html|application\/xhtml/i.test(ctype)) throw new Error('non-html: ' + ctype);
    const html = await res.text();
    return { html, finalUrl: res.url || url, rendered: false };
  } finally { clearTimeout(t); }
}

// ---- JSレンダリング判定（本文が薄い／SPAマーカー） ----
function looksJsRendered(html) {
  if (!html) return true;
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const textLen = $('body').text().replace(/\s+/g, '').length;
  const spaMarker = /__NEXT_DATA__|id=["']root["']|id=["']app["']|ng-version|data-reactroot/i.test(html);
  return textLen < 250 || (spaMarker && textLen < 600);
}

// ---- RPA（Playwright）でレンダリング後にHTML取得。未インストール時はnullを返す ----
let _browserPromise = null;
async function getBrowser() {
  if (_browserPromise) return _browserPromise;
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) { return null; } // playwright未導入 → 静的取得のまま続行
  _browserPromise = chromium.launch({ headless: true }).catch(() => null);
  return _browserPromise;
}
async function fetchRendered(url) {
  const browser = await getBrowser();
  if (!browser) return null;
  let ctx;
  try {
    ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PER_PAGE_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const html = await page.content();
    return { html, finalUrl: page.url(), rendered: true };
  } catch (_) { return null; }
  finally { if (ctx) await ctx.close().catch(() => {}); }
}

// ---- 1ページ取得：静的 → 必要ならRPAにエスカレーション ----
async function fetchPage(url) {
  let r = await fetchStatic(url);
  if (looksJsRendered(r.html)) {
    const rr = await fetchRendered(url);
    if (rr && rr.html) return rr;
  }
  return r;
}

// ホスト名から登録可能ドメイン（eTLD+1 相当）を簡易推定。
// 例: corp.freee.co.jp → freee.co.jp / www.example.com → example.com
// （完全なPublic Suffix Listではなく、日本でよくある二段TLDに対応した近似）
const TWO_LEVEL_SLD = new Set(['co', 'or', 'ne', 'ac', 'go', 'ed', 'gr', 'lg', 'ad', 'com', 'net', 'org', 'gov']);
function registrableDomain(host) {
  const labels = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  // 例: example.co.jp（jp + co）→ 末尾3ラベル
  if (tld.length === 2 && TWO_LEVEL_SLD.has(sld)) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}
function sameRegistrableDomain(hostA, hostB) {
  return registrableDomain(hostA) === registrableDomain(hostB);
}

// ---- 同一サイト内から「担当者名・電話が載っていそうなページ」を発見・スコアリング ----
// 同一オリジンに加え、同一登録可能ドメインの別サブドメイン（例 corp.example.co.jp）も
// ヒントに合致すれば候補に含める（コーポレートサイトが別サブドメインのケースに対応）。
function discoverPages(baseUrl, html) {
  const base = new URL(baseUrl);
  const $ = cheerio.load(html);
  const seen = new Set();
  const scored = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    let u;
    try { u = new URL(href, base); } catch { return; }
    const sameOrigin = u.origin === base.origin;
    const sameReg = sameRegistrableDomain(u.hostname, base.hostname);
    if (!sameOrigin && !sameReg) return;
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    const key = u.toString();
    if (key === baseUrl || seen.has(key)) return;
    seen.add(key);
    const hay = (u.pathname + ' ' + ($(a).text() || '')).toLowerCase();
    let score = 0;
    for (const h of PAGE_HINTS) {
      if (hay.includes(h.toLowerCase())) score += STRONG_HINTS.includes(h) ? 2 : 1;
    }
    if (!sameOrigin) score -= 1; // 別サブドメインはわずかに減点（ヒント必須）
    if (score > 0) scored.push({ url: key, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.url);
}

// ---- 会社概要/お問い合わせ/採用 等の「よくあるパス」を推測生成（ナビにリンクが無いサイト向け） ----
// 同一オリジンと、コーポレート用の corp. サブドメインの両方を対象に少数の定番パスを返す。
const COMMON_PATHS = [
  '/company/', '/company', '/corporate/', '/about/', '/about-us/', '/profile/',
  '/company/profile/', '/outline/', '/overview/', '/contact/', '/contact', '/inquiry/',
  '/company/contact/', '/recruit/', '/recruit', '/saiyo/', '/careers/', '/access/',
];
function guessContactPaths(baseUrl) {
  const base = new URL(baseUrl);
  const out = [];
  const origins = [base.origin];
  // www. を corp. に置換した同一登録可能ドメインのコーポレートサブドメインも試す
  if (/^www\./i.test(base.hostname)) {
    origins.push(base.origin.replace('://www.', '://corp.'));
  } else if (!/^corp\./i.test(base.hostname)) {
    origins.push(base.origin.replace('://', '://corp.'));
  }
  // パス優先で origin を交互に並べる（corp. 側の会社概要/問い合わせも早めに試す）
  for (const p of COMMON_PATHS) {
    for (const origin of origins) out.push(origin + p);
  }
  return out;
}

// ---- 可視テキスト抽出（抽出処理向けに整形・上限カット） ----
function extractText(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,iframe,head').remove();
  let text = $('body').text();
  text = text.replace(/[ \t\u3000]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return text.slice(0, MAX_TEXT_CHARS);
}

async function closeBrowser() {
  if (_browserPromise) { const b = await _browserPromise; if (b) await b.close().catch(() => {}); }
}

module.exports = { fetchStatic, fetchRendered, fetchPage, looksJsRendered, discoverPages, guessContactPaths, registrableDomain, sameRegistrableDomain, extractText, closeBrowser };
