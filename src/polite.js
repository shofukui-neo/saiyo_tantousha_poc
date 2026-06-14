'use strict';
// 責任あるスクレイピングの土台。全てのWeb取得はここを通す。
//  - robots.txt をオリジン単位で遵守（既存 robots.js を利用、Disallow なら取得しない）
//  - ホスト別レート制限（直列化＋最小間隔。サイトに負荷をかけない）
//  - ディスクキャッシュ（同一URLの再取得を避ける。TTL付き）
//  - 軽いリトライ＋バックオフ
// 既存 fetch.js（静的→Playwrightエスカレーション）の上に薄く重ねる設計。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getRobots, isAllowed } = require('./robots');
const { fetchPage, fetchStatic, fetchText } = require('./fetch');
const { USER_AGENT } = require('./config');

const CACHE_DIR = path.resolve(__dirname, '..', 'data', 'scrape-cache');
const DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || '4000', 10);      // ホスト別の最小取得間隔
const CACHE_TTL_MS = parseInt(process.env.SCRAPE_CACHE_TTL_MS || String(7 * 24 * 3600 * 1000), 10);
const MAX_RETRY = parseInt(process.env.SCRAPE_MAX_RETRY || '2', 10);
const RESPECT_ROBOTS = process.env.SCRAPE_IGNORE_ROBOTS !== '1';           // 既定で robots を尊重

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ホスト別の直列実行＋最小間隔（礼儀正しいクロール） ----
// 同一ホストへのアクセスを直列化し、各取得の後に DELAY_MS の間隔をあける。
const hostQueue = new Map();   // host -> Promise（直前タスク完了 + 間隔待ち）
async function throttle(host) {
  const prev = hostQueue.get(host) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  hostQueue.set(host, prev.then(() => mine));
  await prev;                  // 同一ホストの直前タスク完了を待つ
  return async () => { await sleep(DELAY_MS); release(); }; // 取得後に間隔をあけて次へ
}

// ---- ディスクキャッシュ ----
function cachePath(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(CACHE_DIR, h + '.json');
}
function readCache(url) {
  try {
    const p = cachePath(url);
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null; // 期限切れ
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}
function writeCache(url, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(url), JSON.stringify({ url, ...data, _cachedAt: new Date().toISOString() }));
  } catch (_) {}
}

// ---- robots.txt 判定 ----
async function allowedByRobots(url) {
  if (!RESPECT_ROBOTS) return true;
  let u;
  try { u = new URL(url); } catch { return false; }
  const groups = await getRobots(u.origin);
  return isAllowed(groups, USER_AGENT, u.pathname + (u.search || ''));
}

// ---- メイン：1ページを礼儀正しく取得 ----
// 戻り値: { html, finalUrl, fromCache, rendered } または null（robots禁止/失敗）
async function politeGet(url, opts = {}) {
  const { render = 'auto', text = false, noCache = false } = opts;

  if (!noCache) {
    const c = readCache(url);
    if (c && (c.html != null || c.body != null)) {
      return { html: c.html, body: c.body, finalUrl: c.finalUrl || url, fromCache: true, rendered: !!c.rendered };
    }
  }

  if (!(await allowedByRobots(url))) {
    return { blocked: true, reason: 'robots-disallow', finalUrl: url };
  }

  let host;
  try { host = new URL(url).host; } catch { return null; }

  const done = await throttle(host);
  try {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        if (text) {
          const body = await fetchText(url);
          if (!noCache) writeCache(url, { body, finalUrl: url, rendered: false });
          return { body, finalUrl: url, fromCache: false, rendered: false };
        }
        const r = render === 'static' ? await fetchStatic(url) : await fetchPage(url);
        if (!noCache) writeCache(url, { html: r.html, finalUrl: r.finalUrl, rendered: r.rendered });
        return { html: r.html, finalUrl: r.finalUrl, fromCache: false, rendered: r.rendered };
      } catch (e) {
        if (attempt >= MAX_RETRY) return { error: String(e && e.message || e), finalUrl: url };
        await sleep(1000 * (attempt + 1)); // 線形バックオフ
      }
    }
  } finally {
    await done(); // 取得間隔をあけてからホストキューを解放
  }
  return null;
}

module.exports = { politeGet, allowedByRobots, DELAY_MS };
