'use strict';
/**
 * 全媒体ハーベスト共通のHTTP層（素のHTTPS・gzip/br解凍・robots遵守・並列ワーカー・再開台帳）
 * =====================================================================
 * マイナビ以外の新卒媒体（キャリタス／リクナビ／あさがくナビ）を数万社規模で取るための土台。
 * Playwrightは使わない（3媒体とも企業ページはSSRで、素のHTTPで構造値が取れることを実測済み）。
 *
 *  - fetchHtml(url)         … 200以外は '' を返す（呼び側は空文字＝取得失敗として扱う）
 *  - allowed(url)           … robots.txt の Disallow に当たるURLは取りに行かない
 *  - runPool(items, fn, o)  … 並列N・1件ごとに遅延・進捗ログ・定期フラッシュ
 *  - Journal                … JSON台帳（キー→結果）。中断しても取り直さずに再開できる
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { parseRobots } = require('../robots');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

function decode(buf, enc) {
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
  } catch (_) { /* 壊れた圧縮は生のまま返す */ }
  return buf;
}

/**
 * @param {string} url
 * @param {{timeout?:number, redirects?:number, maxBytes?:number}} o
 * @returns {Promise<string>} 本文（200以外・失敗は ''）
 */
function fetchHtml(url, o = {}) {
  const redirects = o.redirects == null ? 4 : o.redirects;
  const maxBytes = o.maxBytes || 8e6;
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (_) { return resolve(''); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      timeout: o.timeout || 25000,
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume();
        let next; try { next = new URL(r.headers.location, u).href; } catch (_) { return resolve(''); }
        return resolve(fetchHtml(next, { ...o, redirects: redirects - 1 }));
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(''); }
      const chunks = []; let n = 0;
      r.on('data', (c) => { chunks.push(c); n += c.length; if (n > maxBytes) req.destroy(); });
      r.on('end', () => resolve(decode(Buffer.concat(chunks), r.headers['content-encoding']).toString('utf8')));
      r.on('error', () => resolve(''));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

// robots.txt はオリジン単位で1回だけ取る。
// 既存 robots.js の isAllowed は前方一致のみで「/corp/*/entry/」のようなワイルドカードを解さないため、
// ここでは * と $ を正規表現に直して判定する（最長一致・同長ならAllow優先）。
const robotsCache = new Map();
function ruleToRe(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}
function robotsAllows(groups, pathAndQuery) {
  if (!groups || !groups.length) return true;
  const g = groups.find((grp) => grp.agents.includes('*'));
  if (!g) return true;
  let decision = true; let len = -1;
  for (const r of g.rules) {
    if (!r.path) continue;
    if (ruleToRe(r.path).test(pathAndQuery) && (r.path.length > len || (r.path.length === len && r.type === 'allow'))) {
      len = r.path.length; decision = r.type === 'allow';
    }
  }
  return decision;
}
async function allowed(url) {
  let u; try { u = new URL(url); } catch (_) { return false; }
  if (!robotsCache.has(u.origin)) {
    const txt = await fetchHtml(u.origin + '/robots.txt', { timeout: 15000 });
    robotsCache.set(u.origin, parseRobots(txt || ''));
  }
  return robotsAllows(robotsCache.get(u.origin), u.pathname + u.search);
}

// HTML → 改行区切りテキスト（構造値を見出し単位で拾うため改行を残す）
const ent = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
function toText(html) {
  return ent(String(html || '').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '\n'))
    .replace(/[ \t　]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function safeWrite(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, content);
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, abs); return; } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EBUSY') { try { fs.writeFileSync(abs, content); fs.unlinkSync(tmp); return; } catch (_) {} }
    }
  }
  try { fs.writeFileSync(abs, content); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
}

/** キー→結果のJSON台帳。done(k) が真なら取り直さない。 */
class Journal {
  constructor(file) {
    this.file = file;
    this.data = {};
    if (fs.existsSync(file)) { try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { this.data = {}; } }
  }
  has(k) { return Object.prototype.hasOwnProperty.call(this.data, k); }
  get(k) { return this.data[k]; }
  // JSON往復で値を複製してから持つ。V8は slice/trim の結果を親文字列への参照として持つため、
  // 1社100KB超のHTML全文が台帳の小さな値を通じて生き残り、2万社で4GBを超えて落ちた（2026-10-15 実測）。
  set(k, v) { this.data[k] = v == null ? v : JSON.parse(JSON.stringify(v)); }
  get size() { return Object.keys(this.data).length; }
  values() { return Object.values(this.data); }
  flush() { safeWrite(this.file, JSON.stringify(this.data)); }
}

/**
 * 並列ワーカー。fn(item, i) の例外は1件の失敗として飲み込む（全体は止めない）。
 * @param {Array} items
 * @param {(item:any, i:number)=>Promise<void>} fn
 * @param {{conc?:number, delay?:number, every?:number, onProgress?:(done:number,total:number)=>void, onFlush?:()=>void}} o
 */
async function runPool(items, fn, o = {}) {
  const conc = Math.max(1, o.conc || 4);
  const delay = o.delay == null ? 150 : o.delay;
  const every = o.every || 200;
  let idx = 0; let done = 0;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      try { await fn(items[i], i); } catch (e) { if (o.onError) o.onError(e, items[i]); }
      done++;
      if (done % every === 0) { if (o.onFlush) o.onFlush(); if (o.onProgress) o.onProgress(done, items.length); }
      if (delay) await sleep(delay);
    }
  };
  await Promise.all(Array.from({ length: conc }, () => worker()));
  if (o.onFlush) o.onFlush();
  if (o.onProgress) o.onProgress(done, items.length);
}

const getArg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const hasFlag = (n) => process.argv.includes('--' + n);

module.exports = { UA, sleep, log, fetchHtml, allowed, robotsAllows, ent, toText, oneLine, safeWrite, Journal, runPool, getArg, hasFlag };
