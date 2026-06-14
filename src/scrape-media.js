'use strict';
// 採用媒体スクレイパ。2系統の機能を提供する：
//  (A) 求人検索エンジン（求人ボックス / Indeed）から「採用中企業」を発見する
//  (B) マイナビ・リクナビ・ワンキャリアの公開検索に企業名を投げ、掲載有無を判定する
//
// ※ 各サイトはJS描画・DOM変更が頻繁なため、SELECTOR/URLは「現状の推定値」。
//    実HTMLに合わせて adapters[].resultSel / extract を調整する前提（calibrate参照）。
//    全取得は polite.js 経由（robots遵守・レート制限・キャッシュ）。
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { normCompanyName } = require('./csv');

// =====================================================================
// (A) 採用中企業の発見：求人検索エンジン
// =====================================================================
// クエリ（職種/エリア等）→ 求人カードから企業名を抽出して集計。
const JOB_ENGINES = [
  {
    name: '求人ボックス',
    // 例: https://求人ボックス.com/<キーワード>の仕事-<エリア>  → 実体は kyujinbox.com
    searchUrl: (q, page) => `https://xn--pckua2a7gp15o89zb.com/${encodeURIComponent(q)}の仕事?pg=${page || 1}`,
    // 求人カード内の企業名要素（要キャリブレーション）
    companySel: ['.c-result-card__company', '.p-result_company', '[class*="company"]'],
  },
  {
    name: 'Indeed',
    searchUrl: (q, page) => `https://jp.indeed.com/jobs?q=${encodeURIComponent(q)}&start=${((page || 1) - 1) * 10}`,
    companySel: ['[data-testid="company-name"]', '.companyName', 'span.companyName'],
  },
];

// 1ページから企業名候補を抽出
function extractCompanies($, selectors) {
  const names = [];
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t && t.length <= 60) names.push(t);
    });
    if (names.length) break; // 最初に当たったセレクタを採用
  }
  return names;
}

// 採用中企業を発見。queries=['介護 東京', '新卒 エンジニア 大阪', ...]
// 戻り値: Map<正規化社名, { 企業名, 媒体:Set, 件数, 職種ヒット }>
async function discoverHiringCompanies(queries, { engines = JOB_ENGINES, maxPagesPerQuery = 1 } = {}) {
  const acc = new Map();
  for (const q of queries) {
    for (const eng of engines) {
      for (let page = 1; page <= maxPagesPerQuery; page++) {
        const url = eng.searchUrl(q, page);
        const r = await politeGet(url);
        if (!r || r.blocked || r.error || !r.html) {
          if (r && r.blocked) console.warn(`  [${eng.name}] robotsで取得不可: ${url}`);
          break;
        }
        const $ = cheerio.load(r.html);
        const names = extractCompanies($, eng.companySel);
        for (const raw of names) {
          const key = normCompanyName(raw);
          if (!key) continue;
          if (!acc.has(key)) acc.set(key, { '企業名': raw, 媒体: new Set(), 件数: 0, クエリ: new Set() });
          const e = acc.get(key);
          e.媒体.add(eng.name);
          e.件数++;
          e.クエリ.add(q);
        }
        if (!names.length) break; // これ以上ページが無い
      }
    }
  }
  return acc;
}

// =====================================================================
// (B) マイナビ・リクナビ・ワンキャリアの掲載有無チェック
// =====================================================================
// 企業名を各サイトの検索に投げ、結果に同名企業が出れば「掲載あり」とする。
const MEDIA_ADAPTERS = [
  {
    name: 'リクナビ',
    // 新卒: job.rikunabi.com の企業検索
    searchUrl: (name) => `https://job.rikunabi.com/2027/search/?kw=${encodeURIComponent(name)}`,
    resultSel: ['.js-companyName', '.castDataArea', '[class*="company"]', 'h2', 'h3'],
  },
  {
    name: 'マイナビ',
    searchUrl: (name) => `https://job.mynavi.jp/27/pc/search/query.html?q=${encodeURIComponent(name)}`,
    resultSel: ['.companyName', '.cassetteJobOffer__name', '[class*="company"]', 'h2', 'h3'],
  },
  {
    name: 'ワンキャリア',
    searchUrl: (name) => `https://www.onecareer.jp/companies/search?keyword=${encodeURIComponent(name)}`,
    resultSel: ['.company-name', '[class*="company"]', 'h2', 'h3', 'a[href*="/companies/"]'],
  },
];

// 検索結果HTMLに対象企業名が含まれるか（正規化一致 or 部分一致）で判定
function resultMatches(html, selectors, targetName) {
  const $ = cheerio.load(html);
  const target = normCompanyName(targetName);
  if (!target) return false;
  const texts = [];
  for (const sel of selectors) {
    $(sel).each((_, el) => { const t = $(el).text().replace(/\s+/g, ' ').trim(); if (t) texts.push(t); });
    if (texts.length) break;
  }
  // セレクタが当たらない場合は本文全体からフォールバック判定
  if (!texts.length) texts.push($('body').text());
  return texts.some((t) => {
    const n = normCompanyName(t);
    return n && (n === target || n.includes(target) || target.includes(n));
  });
}

// 1企業について全媒体の掲載有無を判定。
// 戻り値: { 掲載媒体:[...名], 掲載媒体数, 詳細:{media:bool} }
async function checkMediaListing(companyName, { adapters = MEDIA_ADAPTERS } = {}) {
  const hit = [];
  const detail = {};
  for (const ad of adapters) {
    const url = ad.searchUrl(companyName);
    const r = await politeGet(url);
    if (!r || r.blocked || r.error || !r.html) { detail[ad.name] = false; continue; }
    const ok = resultMatches(r.html, ad.resultSel, companyName);
    detail[ad.name] = ok;
    if (ok) hit.push(ad.name);
  }
  return { 掲載媒体: hit, 掲載媒体数: hit.length, 詳細: detail };
}

module.exports = {
  discoverHiringCompanies, checkMediaListing,
  JOB_ENGINES, MEDIA_ADAPTERS, extractCompanies, resultMatches,
};
