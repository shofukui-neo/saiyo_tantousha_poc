'use strict';
/**
 * 一括ダウンロード（オープンデータの CSV / Excel / ZIP 用）
 * =====================================================================
 * polite.js はHTML用（本文をJSONキャッシュに入れる）なので、バイナリの原本はこちらで落とす。
 * 作法は polite.js と揃える: robots.txt を確認し、同一ホストは直列＋間隔をあけ、
 * 原本は data/obs-raw/<source>/ に保存して再収集時は再利用する。
 *
 * User-Agent は config.USER_AGENT（このツールのbot名）のまま。拒否されたサイトでは偽装せず、
 * 手で落としたファイルを --file で渡す運用にする（登録簿の method=manual-file）。
 */
const fs = require('fs');
const path = require('path');
const { allowedByRobots, getScrapeDelay } = require('../polite');
const { USER_AGENT } = require('../config');
const { rawDir } = require('./store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastHit = new Map(); // host -> 直前の取得完了時刻

async function waitHost(host) {
  const prev = lastHit.get(host) || 0;
  const wait = prev + getScrapeDelay() - Date.now();
  if (wait > 0) await sleep(wait);
}

/**
 * URL を data/obs-raw/<sourceId>/<ファイル名> に保存してパスを返す。
 * @param {string} url
 * @param {{sourceId:string, maxAgeDays?:number, timeoutMs?:number}} opt
 */
async function downloadFile(url, opt) {
  const u = new URL(url);
  const dest = path.join(rawDir(opt.sourceId), decodeURIComponent(path.basename(u.pathname)) || 'index');
  const maxAgeMs = (opt.maxAgeDays == null ? 30 : opt.maxAgeDays) * 86400000;
  if (fs.existsSync(dest) && Date.now() - fs.statSync(dest).mtimeMs < maxAgeMs) return { path: dest, cached: true };

  if (!(await allowedByRobots(url))) throw new Error(`robots.txt で禁止: ${url}`);
  await waitHost(u.host);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeoutMs || 120000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.tmp', buf);
    fs.renameSync(dest + '.tmp', dest);
    return { path: dest, cached: false, bytes: buf.length };
  } finally {
    clearTimeout(timer);
    lastHit.set(u.host, Date.now());
  }
}

module.exports = { downloadFile };
