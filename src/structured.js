'use strict';
// 構造化データ抽出（JSON-LD / schema.org）と sitemap.xml からのページ発見。外部API不使用。
// 多くの企業サイトは Organization/LocalBusiness を JSON-LD で記述しており、
// 電話番号・住所・正式名称を「正規表現より正確」に取得できる。
const cheerio = require('cheerio');
const cfg = require('./config');

// 対象とする schema.org type（組織・事業者系）
const ORG_TYPES = ['Organization', 'Corporation', 'LocalBusiness', 'NGO', 'GovernmentOrganization',
  'EducationalOrganization', 'Store', 'ProfessionalService'];

function isOrgType(type) {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some(t => ORG_TYPES.some(o => String(t).toLowerCase().endsWith(o.toLowerCase())));
}

// JSON-LDのaddressオブジェクト/文字列を住所文字列へ
function addressToString(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr.trim();
  if (Array.isArray(addr)) return addressToString(addr[0]);
  const parts = [addr.addressRegion, addr.addressLocality, addr.streetAddress].filter(Boolean);
  return parts.join('').trim();
}

// ネストした @graph / 配列を平坦化してノード列を得る
function flattenNodes(data) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    out.push(node);
    if (node['@graph']) walk(node['@graph']);
  };
  walk(data);
  return out;
}

/**
 * HTMLの JSON-LD から組織情報（name/telephone/address/url）を抽出。
 * @param {string} html
 * @returns {{name:string, telephone:string, address:string, url:string, email:string}|null}
 */
function extractOrganization(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const found = { name: '', telephone: '', address: '', url: '', email: '' };
  let hit = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text() || $(el).text();
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; } // 壊れたJSON-LDはスキップ
    for (const node of flattenNodes(data)) {
      if (!isOrgType(node['@type'])) continue;
      hit = true;
      if (!found.name && node.name) found.name = String(node.name).trim();
      if (!found.telephone && node.telephone) found.telephone = String(node.telephone).trim();
      if (!found.url && node.url) found.url = String(node.url).trim();
      if (!found.email && node.email) found.email = String(node.email).replace(/^mailto:/i, '').trim();
      if (!found.address && node.address) found.address = addressToString(node.address);
    }
  });
  return hit ? found : null;
}

/**
 * sitemap.xml（インデックス対応）から、会社概要/お問い合わせ/採用に該当しそうなURLを発見。
 * @param {string} origin 例: https://example.co.jp
 * @param {{fetchText:Function}} deps fetchText(url)->string（XML取得）
 * @returns {Promise<string[]>} ヒントに合致するURL（スコア降順）
 */
async function discoverFromSitemap(origin, deps) {
  if (!cfg.USE_SITEMAP || !deps || !deps.fetchText) return [];
  const tried = new Set();
  const allUrls = [];
  const queue = [origin.replace(/\/$/, '') + '/sitemap.xml'];
  let budget = 3; // sitemapインデックスを辿る回数の上限（過負荷防止）
  while (queue.length && budget-- > 0) {
    const sm = queue.shift();
    if (tried.has(sm)) continue;
    tried.add(sm);
    let xml = '';
    try { xml = await deps.fetchText(sm); } catch { continue; }
    if (!xml) continue;
    const locs = parseSitemapLocs(xml);
    if (/<sitemapindex/i.test(xml)) {
      for (const u of locs) if (!tried.has(u)) queue.push(u);
    } else {
      allUrls.push(...locs);
    }
  }
  return rankSitemapUrls(allUrls);
}

// sitemap XML から <loc> を抽出
function parseSitemapLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

// URLパスをヒント語でスコアリングし、会社概要/問い合わせ/採用ページを上位に
function rankSitemapUrls(urls) {
  const seen = new Set();
  const scored = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    let path = '';
    try { path = new URL(u).pathname.toLowerCase(); } catch { continue; }
    let score = 0;
    for (const h of cfg.PAGE_HINTS) if (path.includes(String(h).toLowerCase())) score += cfg.STRONG_HINTS.includes(h) ? 2 : 1;
    if (score > 0) scored.push({ u, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.u);
}

module.exports = {
  extractOrganization, discoverFromSitemap,
  // テスト用
  parseSitemapLocs, rankSitemapUrls, addressToString, isOrgType, flattenNodes,
};
