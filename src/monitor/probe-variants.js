'use strict';
// 変則URL探索: ✕要修復/▽要調整の媒体について、複数の候補URLを実地で叩き、
// どれが「企業リスト＋鮮度」を最も含むかを比較して正しい観測URLを特定する。
// probe-media.js の analyze を再利用。全取得は polite.js 経由。
//   node src/monitor/probe-variants.js
const { politeGet } = require('../polite');
const { analyze } = require('./probe-media');

const enc = encodeURIComponent;
const Q = '新卒';

// 修復候補。各媒体に対し叩く候補URL群（検索結果/企業一覧らしきパスを総当たり）。
const TARGETS = [
  { name: 'マイナビ', cands: [
    `https://job.mynavi.jp/2027/`,
    `https://job.mynavi.jp/27/pc/search/`,
    `https://job.mynavi.jp/27/pc/search/corp/`,
    `https://job.mynavi.jp/27/pc/search/query.html?ind=&q=${enc(Q)}`,
    `https://job.mynavi.jp/27/pc/corpinfo/displayCorpSearch/index?q=${enc(Q)}`,
  ] },
  { name: 'ワンキャリア', cands: [
    `https://www.onecareer.jp/companies`,
    `https://www.onecareer.jp/companies?keyword=${enc(Q)}`,
    `https://www.onecareer.jp/search?keyword=${enc(Q)}`,
    `https://www.onecareer.jp/articles`,
    `https://www.onecareer.jp/`,
  ] },
  { name: 'あさがくナビ', cands: [
    `https://www.gakujo.ne.jp/2027/company/`,
    `https://www.gakujo.ne.jp/2027/search/`,
    `https://www.gakujo.ne.jp/company/`,
    `https://www.gakujo.ne.jp/2027/companysearch/result/?keyword=${enc(Q)}`,
  ] },
  { name: 'ブンナビ', cands: [
    `https://bunnabi.jp/company/`,
    `https://bunnabi.jp/2027/company/`,
    `https://bunnabi.jp/companies`,
    `https://job.bunkahoso.com/`,
  ] },
  { name: 'みん就', cands: [
    `https://www.nikki.ne.jp/company/`,
    `https://www.nikki.ne.jp/event/`,
    `https://www.nikki.ne.jp/2027/`,
    `https://www.nikki.ne.jp/ranking/`,
  ] },
];

async function tryUrl(url) {
  try {
    const r = await Promise.race([
      politeGet(url, { render: 'static' }),
      new Promise((res) => setTimeout(() => res({ error: 'timeout' }), 25000)),
    ]);
    if (!r) return { url, status: 'null' };
    if (r.blocked) return { url, status: 'robots' };
    if (r.error) return { url, status: 'err:' + String(r.error).slice(0, 40) };
    if (!r.html) return { url, status: 'no-html' };
    const a = analyze(r.html, Q);
    return { url, status: 'ok', score: a.compHits + a.companyLinks, comp: a.compHits, link: a.companyLinks, fresh: a.freshCount, samples: a.freshSamples };
  } catch (e) { return { url, status: 'ex:' + String(e && e.message || e).slice(0, 40) }; }
}

(async () => {
  for (const t of TARGETS) {
    console.log(`\n=== ${t.name} ===`);
    const results = [];
    for (const u of t.cands) {
      const r = await tryUrl(u);
      results.push(r);
      const tag = r.status === 'ok' ? `企業${r.comp}/link${r.link} 鮮度${r.fresh}` : r.status;
      console.log(`  [${tag}] ${u.replace('https://', '')}`);
    }
    const best = results.filter((r) => r.status === 'ok').sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 5) console.log(`  → 最良: ${best.url}  (企業${best.comp}/link${best.link}, 鮮度${best.fresh} ${(best.samples || []).slice(0, 3).join('/')})`);
    else console.log(`  → 有効URLなし（全候補で企業密度<5）`);
  }
})();
