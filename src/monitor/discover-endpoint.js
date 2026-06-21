'use strict';
// 実エンドポイント自動発見: トップページHTMLから同一ホストのリンクを抽出し、
// 「企業一覧/検索/会社」系のパス・文言をスコアリング→上位候補を実プローブして
// 企業リストを最も含むURLを特定する。盲目的URL推測の限界を越える手法。
// probe-media.js の analyze を再利用。全取得は polite.js 経由。
//   node src/monitor/discover-endpoint.js
const cheerio = require('cheerio');
const { politeGet } = require('../polite');
const { analyze } = require('./probe-media');

const Q = '新卒';
const HOMES = (process.env.DISCOVER_HOMES ? JSON.parse(process.env.DISCOVER_HOMES) : [
  { name: '薬キャリ', home: 'https://pcareer.m3.com/' },
  { name: 'キャリタス就活', home: 'https://job.career-tasu.jp/' },
  { name: 'type就活', home: 'https://typeshukatsu.jp/' },
]);

// リンクの「企業一覧/検索ページらしさ」スコア（パス＋アンカー文言）。
const PATH_KW = [
  [/company|companies|corp|kigyou|kaisha/i, 4],
  [/search|kensaku|find|list|ichiran/i, 3],
  [/job|recruit|saiyo|offer|entry/i, 2],
  [/2027|2026|27|26/i, 1],
];
const TEXT_KW = [[/企業|会社|法人/, 4], [/検索|一覧|探す|から探す/, 3], [/求人|採用|エントリー/, 2]];

function scoreLink(href, text) {
  let s = 0;
  for (const [re, w] of PATH_KW) if (re.test(href)) s += w;
  for (const [re, w] of TEXT_KW) if (re.test(text || '')) s += w;
  return s;
}

async function get(url) {
  const r = await Promise.race([
    politeGet(url, { render: 'static' }),
    new Promise((res) => setTimeout(() => res({ error: 'timeout' }), 25000)),
  ]);
  return r;
}

async function discover(name, home) {
  console.log(`\n=== ${name} (${home}) ===`);
  const r = await get(home);
  if (!r || r.blocked || r.error || !r.html) { console.log(`  トップ取得不可: ${(r && (r.reason || r.error)) || 'null'}`); return; }
  const $ = cheerio.load(r.html);
  let host; try { host = new URL(home).host; } catch { host = ''; }
  const cands = new Map(); // url -> {score, text}
  $('a[href]').each((_, a) => {
    let href = $(a).attr('href') || '';
    const text = $(a).text().replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return;
    let abs; try { abs = new URL(href, home).toString(); } catch { return; }
    let h; try { h = new URL(abs).host; } catch { return; }
    if (h !== host) return; // 同一ホストのみ
    const s = scoreLink(abs, text);
    if (s <= 0) return;
    const prev = cands.get(abs);
    if (!prev || s > prev.score) cands.set(abs, { score: s, text });
  });
  const top = [...cands.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 6);
  if (!top.length) { console.log('  候補リンクなし（トップが薄い/JSメニュー）'); return; }
  console.log(`  候補 ${top.length}件を実プローブ:`);
  const results = [];
  for (const [url, meta] of top) {
    const pr = await get(url);
    if (!pr || pr.blocked || pr.error || !pr.html) { console.log(`    [${(pr && (pr.reason || pr.error)) || 'null'}] (sc${meta.score}) ${url.replace('https://', '')}`); continue; }
    const a = analyze(pr.html, Q);
    const score = a.compHits + a.companyLinks;
    results.push({ url, ...a, score });
    console.log(`    [企業${a.compHits}/link${a.companyLinks} 鮮度${a.freshCount}] (sc${meta.score}) ${url.replace('https://', '')}`);
  }
  const best = results.sort((x, y) => y.score - x.score)[0];
  if (best && best.score >= 5) console.log(`  → 発見: ${best.url}  (企業${best.compHits}/link${best.companyLinks}, 鮮度${best.freshCount})`);
  else console.log('  → 静的に企業リストを出すページは見つからず（JS描画 or 別経路）');
}

(async () => {
  for (const m of HOMES) { try { await discover(m.name, m.home); } catch (e) { console.log(`  例外: ${e && e.message}`); } }
})();
