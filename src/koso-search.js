'use strict';
// 検索APIのプラガブル層（高卒採用企業の発掘用）。
// 無料HTML検索（search.js の Bing/DDG）は「1クエリ9件のSEO記事」に埋もれて
// 企業の採用ページに到達できないため、正式な検索APIで発掘深度を確保する。
//
// 対応プロバイダ（環境変数のキーで自動選択。1つ設定すれば動く）:
//   - Google Programmable Search / Custom Search JSON API
//        GOOGLE_CSE_KEY + GOOGLE_CSE_CX  （無料100クエリ/日、以降 $5/1000・最大1万/日）
//   - Brave Search API
//        BRAVE_API_KEY                   （無料2000クエリ/月）
//   - Serper.dev（Google結果のラッパ）
//        SERPER_KEY
//
// いずれも戻り値は共通形 { title, link, snippet, displayLink } の配列。
require('dotenv').config();

const env = (k) => (process.env[k] || '').trim();

// どのプロバイダを使うか決定（明示 KOSO_SEARCH_PROVIDER > 自動検出）。
function pickProvider() {
  const explicit = env('KOSO_SEARCH_PROVIDER').toLowerCase();
  if (explicit) return explicit;
  if (env('GOOGLE_CSE_KEY') && env('GOOGLE_CSE_CX')) return 'google';
  if (env('BRAVE_API_KEY')) return 'brave';
  if (env('SERPER_KEY')) return 'serper';
  return '';
}

// キー未設定時のセットアップ案内（呼び出し側が表示する）。
function setupHelp() {
  return [
    '検索APIキーが未設定です。次のいずれか1つを .env に設定してください:',
    '',
    '  ● Google Programmable Search（推奨・無料100件/日）',
    '      GOOGLE_CSE_KEY=<APIキー>',
    '      GOOGLE_CSE_CX=<検索エンジンID(cx)>',
    '      取得: https://programmablesearchengine.google.com/ で「ウェブ全体を検索」の',
    '            検索エンジンを作成し cx を取得 → https://console.cloud.google.com/ で',
    '            Custom Search API を有効化して APIキーを発行。',
    '',
    '  ● Brave Search API（無料2000件/月）',
    '      BRAVE_API_KEY=<トークン>   取得: https://api-dashboard.search.brave.com/',
    '',
    '  ● Serper.dev（Google結果）',
    '      SERPER_KEY=<APIキー>       取得: https://serper.dev/',
    '',
    '  （任意）KOSO_SEARCH_PROVIDER=google|brave|serper で明示指定も可能。',
  ].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = parseInt(env('KOSO_SEARCH_TIMEOUT_MS') || '15000', 10);

async function getJson(url, headers, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const opts = { headers: headers || {}, signal: ctrl.signal, redirect: 'follow' };
    if (body != null) { opts.method = 'POST'; opts.body = body; }
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 非JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally { clearTimeout(t); }
}

// ---- Google Custom Search JSON API ----
// start は 1,11,21,... （1ページ10件、最大 start=91 まで＝100件）。
async function googleSearch(q, { start = 1 } = {}) {
  const key = env('GOOGLE_CSE_KEY'), cx = env('GOOGLE_CSE_CX');
  const params = new URLSearchParams({
    key, cx, q, num: '10', hl: 'ja', lr: 'lang_ja', gl: 'jp', safe: 'off',
  });
  if (start > 1) params.set('start', String(start));
  const r = await getJson('https://www.googleapis.com/customsearch/v1?' + params.toString());
  if (!r.ok) {
    const reason = r.json && r.json.error && r.json.error.message ? r.json.error.message : ('HTTP ' + r.status);
    const err = new Error('Google CSE: ' + reason);
    err.status = r.status;
    throw err;
  }
  const items = (r.json && r.json.items) || [];
  return items.map((it) => ({
    title: it.title || '', link: it.link || '', snippet: it.snippet || '', displayLink: it.displayLink || '',
  }));
}

// ---- Brave Search API ----
async function braveSearch(q, { start = 1 } = {}) {
  const offset = Math.max(0, Math.floor((start - 1) / 10)); // Braveは offset(ページ番号) 0..9
  const params = new URLSearchParams({ q, country: 'jp', search_lang: 'jp', ui_lang: 'ja-JP', count: '20', offset: String(offset) });
  const r = await getJson('https://api.search.brave.com/res/v1/web/search?' + params.toString(), {
    'Accept': 'application/json', 'X-Subscription-Token': env('BRAVE_API_KEY'),
  });
  if (!r.ok) { const e = new Error('Brave: HTTP ' + r.status + ' ' + (r.text || '').slice(0, 120)); e.status = r.status; throw e; }
  const results = (r.json && r.json.web && r.json.web.results) || [];
  return results.map((it) => ({
    title: it.title || '', link: it.url || '', snippet: it.description || '',
    displayLink: (() => { try { return new URL(it.url).hostname; } catch { return ''; } })(),
  }));
}

// ---- Serper.dev（Google結果）----
async function serperSearch(q, { start = 1 } = {}) {
  const page = Math.max(1, Math.ceil(start / 10));
  const r = await getJson('https://google.serper.dev/search',
    { 'X-API-KEY': env('SERPER_KEY'), 'Content-Type': 'application/json' },
    JSON.stringify({ q, gl: 'jp', hl: 'ja', num: 10, page }));
  if (!r.ok) { const e = new Error('Serper: HTTP ' + r.status + ' ' + (r.text || '').slice(0, 120)); e.status = r.status; throw e; }
  const organic = (r.json && r.json.organic) || [];
  return organic.map((it) => ({
    title: it.title || '', link: it.link || '', snippet: it.snippet || '',
    displayLink: (() => { try { return new URL(it.link).hostname; } catch { return ''; } })(),
  }));
}

const PROVIDERS = { google: googleSearch, brave: braveSearch, serper: serperSearch };

// 1クエリを検索（最大 pages ページぶん、共通形の配列を返す）。
// レート/日次上限に当たったら理由つきで例外を投げる（オーケストレータが停止判断）。
async function search(q, { pages = 1, delayMs = 400 } = {}) {
  const provider = pickProvider();
  const fn = PROVIDERS[provider];
  if (!fn) { const e = new Error('no-search-provider'); e.noProvider = true; throw e; }
  const out = [];
  for (let p = 0; p < pages; p++) {
    const start = 1 + p * 10;
    let batch;
    try { batch = await fn(q, { start }); }
    catch (e) { if (p === 0) throw e; break; } // 2ページ目以降の失敗は打ち止め扱い
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 10) break;
    if (p < pages - 1) await sleep(delayMs);
  }
  return out;
}

module.exports = { search, pickProvider, setupHelp, PROVIDERS };
