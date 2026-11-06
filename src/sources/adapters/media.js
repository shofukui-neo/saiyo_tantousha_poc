'use strict';
/**
 * アダプタ: 新卒媒体（カタログ全媒体の共通アダプタ）
 * =====================================================================
 * 媒体ごとの違いは src/sources/media.json の crawl 設定（プローブで自動学習）だけで吸収する:
 *   crawl.detail_regex … 企業詳細ページのURLの型
 *   crawl.list_urls    … 企業詳細へのリンクが出ていた一覧ページ
 *   crawl.render       … static（HTML取得）か auto（JS描画。User-Agent はこのツールのbot名のまま）
 *
 * 収集の流れ: サイトマップ（型に合うURL）＋一覧の巡回 → 未取得の詳細ページを最大 --max-detail 件取得 →
 *   抽出結果を data/obs-raw/<id>/details.jsonl に追記（中断・再開できる。次回は続きから）→
 *   これまでの全件を観測として返す（媒体側の代表番号は落とす）。
 */
const fs = require('fs');
const path = require('path');
const { politeGet } = require('../../polite');
const { rawDir } = require('../store');
const { crawlListings, sitemapDetailUrls } = require('../media-discover');
const { extractDetail, dropMediaPhones } = require('../media-extract');

function readDone(file) {
  const done = new Map();
  if (!fs.existsSync(file)) return done;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); done.set(r.url, r.obs || null); } catch {}
  }
  return done;
}

/**
 * @param {{source:object, args:object, log:(m:string)=>void}} ctx
 *   args.maxDetail（既定300）/ args.maxList（既定60）/ args.refresh（取得済みも取り直す）
 */
async function collect(ctx) {
  const m = ctx.source.media;
  if (!m || !m.crawl || !m.crawl.detail_regex) throw new Error(`[${ctx.source.id}] 巡回設定がありません。先に media-probe を実行してください`);
  const maxDetail = parseInt(ctx.args['max-detail'] || ctx.args.maxDetail || '300', 10);
  const maxList = parseInt(ctx.args['max-list'] || ctx.args.maxList || '60', 10);
  const file = path.join(rawDir(ctx.source.id), 'details.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const done = ctx.args.refresh ? new Map() : readDone(file);

  // 1) 詳細URLを集める（サイトマップ → 一覧の巡回）
  const urls = new Map(); // url -> アンカーの社名
  if (m.crawl.sitemap_hits) {
    for (const u of await sitemapDetailUrls(m.url, m.crawl.detail_regex, { sourceId: ctx.source.id, limit: 20000 })) urls.set(u, '');
  }
  const pending = () => [...urls.keys()].filter((u) => !done.has(u)).length;
  if (pending() < maxDetail) {
    const starts = [...new Set([...(m.crawl.list_urls || []), m.url])];
    const crawl = await crawlListings(starts, { regex: m.crawl.detail_regex, render: m.crawl.render, maxListPages: maxList });
    for (const [u, name] of crawl.details) if (!urls.has(u) || name) urls.set(u, name);
  }
  ctx.log(`企業詳細URL ${urls.size.toLocaleString()} 件（取得済み ${done.size.toLocaleString()}・未取得 ${pending().toLocaleString()}）`);

  // 2) 未取得の詳細ページを取る
  let n = 0, got = 0;
  for (const [url, anchorName] of urls) {
    if (n >= maxDetail) break;
    if (done.has(url)) continue;
    n++;
    const r = await politeGet(url, { render: m.crawl.render });
    const obs = r && r.html ? extractDetail(r.html, url, { anchorName, mediaName: m.name }) : null;
    done.set(url, obs);
    fs.appendFileSync(file, JSON.stringify({ url, at: new Date().toISOString(), obs }) + '\n');
    if (obs) got++;
    if (n % 25 === 0) ctx.log(`  ${n}/${Math.min(maxDetail, pending() + n)} 取得（社名あり ${got}）`);
  }

  // 3) これまでの全件を観測にする
  const observations = [...done.values()].filter(Boolean).map((o) => ({ ...o, extra: { ...o.extra } }));
  const shared = dropMediaPhones(observations);
  if (shared.length) ctx.log(`媒体側の代表番号として落とした電話: ${shared.join(', ')}`);
  return { observations, meta: { detail_urls: urls.size, fetched_now: n, extracted_now: got, total: observations.length } };
}

module.exports = { collect };
