'use strict';
// 企業名 → 公式HPのURLを発見する（原則APIキー不要）。
// 既定では DuckDuckGo の HTML エンドポイント（キー不要）で検索し、
// 求人媒体・SNS・企業DB等を除外したうえで「公式コーポレートサイトらしさ」をスコアリング。
// 上位候補は実際にページ取得して企業名の一致を検証してから採用する。
const cheerio = require('cheerio');
const cfg = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 企業名から法人格・装飾を落とした「核」を作る（一致判定・トークン化の土台）
function companyCore(name) {
  return String(name || '')
    .replace(/\(株\)|\(有\)|（株）|（有）/g, '')
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|医療法人|学校法人|特定非営利活動法人|NPO法人/g, '')
    .replace(/[\s　]+/g, '')
    .replace(/[,，.。・･]/g, '')
    .trim();
}

// 企業名を比較用トークンへ（核全体 ＋ 連続する漢字/カナ/英数のかたまり）
function nameTokens(name) {
  const core = companyCore(name);
  const toks = new Set();
  if (core) toks.add(core.toLowerCase());
  const runs = core.match(/[一-龥々]{2,}|[゠-ヿー]{2,}|[A-Za-z0-9]{2,}/g) || [];
  for (const r of runs) toks.add(r.toLowerCase());
  return [...toks];
}

// Bing の /ck/a?...&u=a1<base64url> リダイレクトを実URLへ復元
function decodeBingHref(href) {
  if (!href) return '';
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (!/bing\.com$/i.test(u.hostname.replace(/^www\./, 'bing.com')) || !u.pathname.startsWith('/ck/a')) {
      return /^https?:\/\//i.test(href) ? href : '';
    }
    const enc = u.searchParams.get('u');
    if (!enc) return '';
    let b = enc.replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const dec = Buffer.from(b, 'base64').toString('utf8');
    return /^https?:\/\//i.test(dec) ? dec : '';
  } catch (_) {
    return '';
  }
}

// DuckDuckGo の l/?uddg= リダイレクトを実URLへ復元
function decodeDdgHref(href) {
  if (!href) return '';
  try {
    if (href.startsWith('//')) href = 'https:' + href;
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    if (/duckduckgo\.com$/i.test(u.hostname) && u.pathname.startsWith('/l/')) return ''; // 復元できないリダイレクトは捨てる
    return u.toString();
  } catch (_) {
    return '';
  }
}

// www. を外した実効ドメイン
function rootDomain(hostname) {
  return String(hostname || '').replace(/^www\./i, '').toLowerCase();
}

// 除外ドメイン（求人媒体・SNS・企業DB等）か？
function isExcludedDomain(hostname, excludeList = cfg.EXCLUDE_DOMAINS) {
  const host = rootDomain(hostname);
  return excludeList.some((d) => host === d || host.endsWith('.' + d));
}

// Bing 検索結果HTMLから候補（url, title, snippet）を抽出
function parseBingHtml(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('li.b_algo').each((_, li) => {
    const a = $(li).find('h2 a').first();
    const url = decodeBingHref(a.attr('href'));
    if (!url || !/^https?:\/\//i.test(url)) return;
    let host;
    try { host = new URL(url).hostname; } catch { return; }
    if (seen.has(url)) return;
    seen.add(url);
    const title = (a.text() || '').replace(/\s+/g, ' ').trim();
    const snippet = ($(li).find('.b_caption p').first().text() || $(li).find('.b_caption').first().text() || '').replace(/\s+/g, ' ').trim();
    out.push({ url, host, domain: rootDomain(host), title, snippet });
  });
  return out;
}

// DuckDuckGo HTML のレスポンスから候補（url, title, snippet）を抽出
function parseDdgHtml(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a.result__a, a.result__url, a[href*="uddg="]').each((_, a) => {
    const url = decodeDdgHref($(a).attr('href'));
    if (!url || !/^https?:\/\//i.test(url)) return;
    let host;
    try { host = new URL(url).hostname; } catch { return; }
    const key = rootDomain(host);
    if (seen.has(url)) return;
    seen.add(url);
    // タイトル/スニペットは同じ result ブロックから拾えるだけ拾う
    const block = $(a).closest('.result, .web-result');
    const title = ($(a).text() || block.find('.result__a').first().text() || '').replace(/\s+/g, ' ').trim();
    const snippet = (block.find('.result__snippet').first().text() || '').replace(/\s+/g, ' ').trim();
    out.push({ url, host, domain: key, title, snippet });
  });
  return out;
}

// 候補を「公式コーポレートサイトらしさ」でスコアリング（ネットワーク不要・純ロジック）
function scoreCandidates(candidates, companyName) {
  const tokens = nameTokens(companyName);
  const scored = [];
  candidates.forEach((c, rank) => {
    if (isExcludedDomain(c.host)) return; // 求人媒体・SNS等は除外
    let score = 0;
    const reasons = [];

    // 上位表示ほど加点（rank 0 が最上位）
    const rankBonus = Math.max(0, 5 - rank);
    score += rankBonus;

    // タイトル/スニペットに企業名トークンが出る
    const hay = (c.title + ' ' + c.snippet).toLowerCase();
    const titleHit = tokens.some((t) => hay.includes(t));
    if (titleHit) { score += 3; reasons.push('name-in-title'); }

    // ドメイン名そのものに企業名の英数トークンが含まれる（例: kabu.co.jp）
    const domHit = tokens.some((t) => /^[a-z0-9-]+$/.test(t) && t.length >= 3 && c.domain.includes(t));
    if (domHit) { score += 3; reasons.push('name-in-domain'); }

    // TLD によるコーポレートらしさ
    for (const [tld, bonus] of Object.entries(cfg.TLD_BONUS)) {
      if (c.domain.endsWith(tld)) { score += bonus; if (bonus) reasons.push('tld' + tld); break; }
    }

    // トップに近いパスを優遇（深い下層ページより会社トップ）
    let path = '/';
    try { path = new URL(c.url).pathname || '/'; } catch (_) {}
    const depth = path.split('/').filter(Boolean).length;
    if (depth === 0) { score += 2; reasons.push('root-path'); }
    else if (depth >= 3) { score -= 1; }

    // 「採用」「会社概要」等の語がタイトルにあると公式の確度UP（弱い加点）
    if (/採用|recruit|会社概要|company|corporate|について|公式/i.test(hay)) { score += 1; reasons.push('corp-word'); }

    scored.push({ ...c, score, rank, titleHit, domHit, reasons });
  });
  // 同点はドメインの短さ（=トップ階層らしさ）で寄せる
  scored.sort((a, b) => b.score - a.score || a.domain.length - b.domain.length);
  return scored;
}

// 取得済みページ本文/タイトルに企業名が現れるか（URL検証用・純ロジック）
function pageMatchesCompany(companyName, pageTitle, pageText) {
  const tokens = nameTokens(companyName);
  const hayTitle = String(pageTitle || '').toLowerCase();
  const hayText = String(pageText || '').slice(0, 4000).toLowerCase();
  // 核（法人格を除いた社名全体）が本文かタイトルに出れば一致とみなす
  const core = companyCore(companyName).toLowerCase();
  if (core && core.length >= 2 && (hayTitle.includes(core) || hayText.includes(core))) return true;
  // 核が出なくても、漢字/英数トークンの過半が本文に出れば一致
  const meaningful = tokens.filter((t) => t.length >= 2);
  if (!meaningful.length) return false;
  const hits = meaningful.filter((t) => hayTitle.includes(t) || hayText.includes(t)).length;
  return hits >= Math.ceil(meaningful.length / 2);
}

// Bing 検索結果ページを取得し、候補配列を返す（first は 1始まりの開始位置＝ページング用）
async function bingSearch(query, first = 1) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.PER_PAGE_TIMEOUT_MS);
  try {
    const params = { q: query, setlang: 'ja', cc: 'JP' };
    if (first > 1) params.first = String(first);
    const url = cfg.BING_HTML_URL + '?' + new URLSearchParams(params).toString();
    const res = await fetch(url, {
      headers: { 'User-Agent': cfg.SEARCH_USER_AGENT, 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8' },
      signal: ctrl.signal, redirect: 'follow',
    });
    if (!res.ok) throw new Error('Bing HTTP ' + res.status);
    return parseBingHtml(await res.text());
  } finally {
    clearTimeout(t);
  }
}

// DuckDuckGo HTML へクエリを投げて候補配列を返す
async function ddgSearch(query) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.PER_PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.DDG_HTML_URL, {
      method: 'POST',
      headers: {
        'User-Agent': cfg.SEARCH_USER_AGENT,
        'Accept-Language': 'ja,en;q=0.8',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ q: query, kl: 'jp-jp' }).toString(),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('DDG HTTP ' + res.status);
    return parseDdgHtml(await res.text());
  } finally {
    clearTimeout(t);
  }
}

// 所在地文字列を照合トークン（都道府県＋市区町村）に分解
function addressTokens(addr) {
  const s = String(addr || '').trim();
  if (!s) return [];
  const tokens = [];
  const pref = s.match(/(北海道|東京都|京都府|大阪府|.{2,3}県)/);
  if (pref) tokens.push(pref[1]);
  const city = s.match(/(?:北海道|東京都|京都府|大阪府|.{2,3}県)\s*(.+?[市区町村])/);
  if (city && city[1]) tokens.push(city[1]);
  return tokens;
}

// 設定された検索エンジンでクエリを実行し、候補配列を返す
async function runSearch(query) {
  const engine = String(cfg.SEARCH_ENGINE).toLowerCase();
  if (engine === 'duckduckgo' || engine === 'ddg') return ddgSearch(query);
  return bingSearch(query); // 既定: bing
}

/**
 * 企業名から公式HPのURLを発見する。
 * @param {string} companyName
 * @param {{fetchPage?:Function, extractText?:Function}} deps fetch/抽出関数（テスト時に差し替え可）
 * @param {{addressHint?:string}} opt 同名企業の取り違え防止に使う所在地ヒント（gBizINFOの所在地等）
 * @returns {Promise<{url:string|null, source:string, verified:boolean, candidates:number, error?:string}>}
 */
async function discoverUrl(companyName, deps = {}, opt = {}) {
  if (!companyName || !companyName.trim()) {
    return { url: null, source: 'search', verified: false, candidates: 0, error: 'empty company name' };
  }
  if (String(cfg.SEARCH_ENGINE).toLowerCase() === 'none') {
    return { url: null, source: 'search-disabled', verified: false, candidates: 0, error: 'SEARCH_ENGINE=none' };
  }

  // 公式サイトに当たりやすいクエリを順に試す
  const queries = [`${companyName} 公式サイト`, `${companyName} 会社概要 採用`];
  let candidates = [];
  let lastErr = '';
  for (const q of queries) {
    try {
      const parsed = (await runSearch(q)).slice(0, cfg.SEARCH_MAX_CANDIDATES);
      if (parsed.length) { candidates = parsed; break; }
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
    await sleep(cfg.SEARCH_DELAY_MS);
  }
  if (!candidates.length) {
    return { url: null, source: 'search', verified: false, candidates: 0, error: lastErr || 'no results' };
  }

  const scored = scoreCandidates(candidates, companyName);
  if (!scored.length) {
    return { url: null, source: 'search', verified: false, candidates: candidates.length, error: 'all candidates excluded' };
  }

  // 上位を実際に取得して企業名一致を検証（fetch/extract が渡された時のみ）
  const fetchPage = deps.fetchPage;
  const extractText = deps.extractText;
  // 所在地ヒント（gBizINFO等）から照合用トークンを作る（都道府県＋市区町村まで）
  const addrTokens = addressTokens(opt.addressHint);
  if (fetchPage && extractText) {
    const top = scored.slice(0, cfg.SEARCH_VERIFY_TOP);
    let nameMatched = null; // 名前一致したが住所未確認の最初の候補
    for (const cand of top) {
      try {
        const origin = new URL(cand.url).origin; // 検証はトップ（origin）で行う
        const page = await fetchPage(origin);
        const $ = cheerio.load(page.html || '');
        const title = $('title').first().text() || '';
        const text = extractText(page.html || '');
        if (pageMatchesCompany(companyName, title, text)) {
          const url = page.finalUrl || origin;
          // 住所ヒントがあり、ページに所在地（都道府県＋市区）が一致 → 同名取り違えをほぼ排除＝最優先で確定
          if (addrTokens.length && addrTokens.every(t => text.includes(t))) {
            return { url, source: 'search+verified+address', verified: true, candidates: candidates.length };
          }
          if (!nameMatched) nameMatched = { url, candidates: candidates.length };
          // 住所ヒントが無ければ名前一致だけで即確定（従来挙動）
          if (!addrTokens.length) return { url, source: 'search+verified', verified: true, candidates: candidates.length };
        }
      } catch (_) { /* 次の候補へ */ }
      await sleep(cfg.SEARCH_DELAY_MS);
    }
    // 住所までは一致しなかったが、名前一致は得られた場合
    if (nameMatched) return { url: nameMatched.url, source: 'search+verified', verified: true, candidates: nameMatched.candidates };
  }

  // 検証は通らなかったが最有力候補は返す（origin に正規化）。source で未検証と分かるようにする。
  let best = scored[0].url;
  try { best = new URL(scored[0].url).origin; } catch (_) {}
  return { url: best, source: 'search(unverified)', verified: false, candidates: candidates.length };
}

module.exports = {
  discoverUrl,
  // 検索エンジン取得（discover.js から再利用）
  bingSearch, ddgSearch, runSearch,
  // 以下はテスト用に公開（ネットワーク不要の純ロジック）
  companyCore, nameTokens, decodeDdgHref, decodeBingHref, rootDomain, isExcludedDomain,
  parseDdgHtml, parseBingHtml, scoreCandidates, pageMatchesCompany, addressTokens,
};
