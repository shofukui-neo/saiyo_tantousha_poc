'use strict';
/**
 * リクナビ 全掲載企業ハーベスト（sitemap → 企業ページの埋め込みJSON）
 * =====================================================================
 * 実地調査（2026-10-15）:
 *   - robots.txt が公開する SitemapIndex_companyjobs.xml に /company_jobs/{id}/ が全社分（6,343社）載る。
 *   - 企業ページは Next.js の SSR。__NEXT_DATA__ の props.pageProps.data に
 *       employerName / industry / companyOverview{address, ceoName, phoneNumber, corporateWebsite}
 *       jobCards[]{title, programTypeLabels(説明会・イベント/仕事体験/インターンシップ/本選考…),
 *                  applicationDueDate, startMonth, lettice.datePublished}
 *     が素のHTTPで取れる。従業員数と採用人数は載らない（＝他媒体・CRMの値で補う）。
 *
 * 出力: data/allmedia/rikunabi.json（company_jobs ID → 構造値）
 * 使い方: node src/allmedia/rikunabi.js [--conc 4] [--delay 200] [--limit 0]
 */
const path = require('path');
const { fetchHtml, allowed, Journal, runPool, log, getArg, oneLine } = require('./http');
const { normalizeJpPhone } = require('../phone');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'allmedia', 'rikunabi.json');
const CONC = parseInt(getArg('conc', '4'), 10);
const DELAY = parseInt(getArg('delay', '200'), 10);
const LIMIT = parseInt(getArg('limit', '0'), 10);
const INDEX = 'https://job.rikunabi.com/SitemapIndex_companyjobs.xml';

async function listIds() {
  const idx = await fetchHtml(INDEX);
  const maps = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const ids = new Set();
  for (const m of maps) {
    const x = await fetchHtml(m);
    for (const r of x.matchAll(/\/company_jobs\/(\d+)\//g)) ids.add(r[1]);
  }
  return [...ids];
}

function parseCompany(html, id) {
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!nd) return null;
  let d; try { d = JSON.parse(nd[1]).props.pageProps.data; } catch (_) { return null; }
  if (!d || !d.employerName) return null;
  const ov = d.companyOverview || {};
  const cards = Array.isArray(d.jobCards) ? d.jobCards : [];
  const labels = {};
  for (const c of cards) for (const l of c.programTypeLabels || []) labels[l] = (labels[l] || 0) + 1;
  const pub = cards.map((c) => c.lettice && c.lettice.datePublished).filter(Number.isFinite).sort((a, b) => b - a);
  const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
  return {
    id, 企業名: oneLine(ov.companyNameDetail || d.employerName), 表示名: oneLine(d.employerName),
    業種: oneLine(d.industry || ''), 本社所在地: oneLine(ov.address || ''), 代表者名: oneLine(ov.ceoName || ''),
    電話番号: normalizeJpPhone(ov.phoneNumber || '') || '', 公式URL: ov.corporateWebsite || '',
    掲載件数: cards.length, 種別件数: labels,
    インターン件数: (labels['インターンシップ'] || 0) + (labels['仕事体験'] || 0),
    説明会件数: labels['説明会・イベント'] || 0,
    本選考件数: Object.entries(labels).filter(([k]) => /本選考|選考|募集/.test(k) && !/説明会|インターン|仕事体験/.test(k)).reduce((a, [, v]) => a + v, 0),
    最新掲載日: iso(pub[0]), 最古掲載日: iso(pub[pub.length - 1]),
    締切あり: cards.filter((c) => c.applicationDueDate && c.applicationDueDate.label).length,
    掲載本文: cards.map((c) => [c.title, c.subtitle, (c.programTypeLabels || []).join('/'), c.startMonth].filter(Boolean).join(' ')).join('\n').slice(0, 3000),
    url: 'https://job.rikunabi.com/company_jobs/' + id + '/',
  };
}

async function main() {
  const j = new Journal(OUT);
  const ids = await listIds();
  log(`リクナビ sitemap: ${ids.length}社`);
  if (!ids.length) { process.exitCode = 1; return; }
  let todo = ids.filter((id) => !j.has(id));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  const st = { ok: 0, ng: 0, tel: 0 };
  await runPool(todo, async (id) => {
    const url = 'https://job.rikunabi.com/company_jobs/' + id + '/';
    if (!(await allowed(url))) { j.set(id, { id, 失敗: 'robots' }); return; }
    let html = await fetchHtml(url);
    if (!html) html = await fetchHtml(url);
    const r = html ? parseCompany(html, id) : null;
    if (!r) { j.set(id, { id, 失敗: html ? '構造不一致' : '取得できず' }); st.ng++; return; }
    j.set(id, r); st.ok++; if (r.電話番号) st.tel++;
  }, { conc: CONC, delay: DELAY, every: 200, onFlush: () => j.flush(), onProgress: (d, t) => log(`  リクナビ ${d}/${t} 取得${st.ok} 失敗${st.ng} 電話${st.tel}`) });
  log(`完了: 台帳 ${j.size}社 → ${path.relative(ROOT, OUT)}`);
}
if (require.main === module) main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exitCode = 1; });

module.exports = { parseCompany, OUT };
