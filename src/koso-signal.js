'use strict';
// 高卒「新卒」採用シグナルの判定と、企業名の抽出。純ロジック（ネットワーク不要＝テスト可能）。
//
// 採用する定義（ユーザー確定）＝「高校新卒を採る企業」:
//   高卒シグナル（高卒/高等学校卒業(見込)/高卒採用 …）AND 新卒シグナル（新卒/新規学卒/○年3月卒 …）
//   を満たし、かつ「今まさに募集」を示す要素（募集要項/初任給/エントリー/該当年度 …）があること。
//   中途・派遣・アルバイト専業や、解説記事・ランキング等の情報ページは除外する。
const cheerio = require('cheerio');
const { normCompanyName } = require('./csv');

// ---- キーワード群 ----
// 高卒（学歴）シグナル
const KOSO = [
  '高卒', '高卒者', '高卒採用', '高校新卒', '新規高卒', '高等学校卒業', '高等学校卒業見込',
  '高校卒業見込', '高校卒業', '高校生採用', '高校生の採用',
];
// 新卒シグナル（＝中途と切り分ける）
const SHINSOTSU = [
  '新卒', '新規学卒', '新規学卒者', '高校新卒', '新規高卒', '定期採用', '新卒採用',
];
// 「今まさに募集」を示す要素
const ACTIVE = [
  '募集要項', '募集職種', '募集要領', '初任給', 'エントリー', '採用情報', '採用サイト',
  '募集中', '応募資格', '選考', '説明会', '求人票', '内定',
];
// 年度シグナル（該当年度なら現役の可能性が高い）。生成側で現在年から補正可能。
function yearSignals(baseYear) {
  const ys = [];
  for (let y = baseYear; y <= baseYear + 2; y++) {
    ys.push(String(y) + '年卒', String(y) + '年3月', String(y) + '年度', String(y) + '卒', '令和' + (y - 2018) + '年');
  }
  return ys;
}
// 除外（情報記事・まとめ・ランキング等）。タイトルに強く効く。
const GUIDE = /とは|ランキング|おすすめ|徹底解説|完全ガイド|まとめ|一覧|比較|違い|コツ|方法|なるには|口コミ|評判|する方法|べき|選$|完全版|入門|基礎知識|注意点|メリット|デメリット/;
// 除外（明確に高卒新卒ではない文脈）
const NEG = /中途採用のみ|中途のみ|派遣社員|人材派遣|アルバイト・パート募集|業務委託のみ/;

const hitsOf = (hay, list) => list.filter((k) => hay.includes(k));

/**
 * 高卒新卒シグナルを判定する。
 * @param {{title?:string, snippet?:string, text?:string, baseYear?:number}} o
 * @returns {{isKosoShinsotsu:boolean, kosoHits:string[], shinsotsuHits:string[], activeHits:string[], yearHits:string[], score:number, reason:string}}
 */
function classifyKoso({ title = '', snippet = '', text = '', baseYear } = {}) {
  const yr = baseYear || 2026;
  const hay = [title, snippet, text].join('\n');
  const kosoHits = hitsOf(hay, KOSO);
  const shinsotsuHits = hitsOf(hay, SHINSOTSU);
  const activeHits = hitsOf(hay, ACTIVE);
  const yearHits = hitsOf(hay, yearSignals(yr));
  const neg = NEG.test(hay);
  const guideTitle = GUIDE.test(title);

  let reason = '';
  let ok = true;
  if (!kosoHits.length) { ok = false; reason = 'no-koso-signal'; }
  else if (!shinsotsuHits.length) { ok = false; reason = 'no-shinsotsu-signal(中途/高卒可の可能性)'; }
  else if (!activeHits.length && !yearHits.length) { ok = false; reason = 'no-active-recruit-signal'; }
  else if (neg) { ok = false; reason = 'negative-context(中途/派遣/バイト)'; }
  else if (guideTitle) { ok = false; reason = 'guide-article-title'; }

  // スコア（参考・並べ替え用）: 各シグナルの充足度。
  const score = Math.min(100,
    (kosoHits.length ? 30 : 0) +
    (shinsotsuHits.length ? 25 : 0) +
    Math.min(25, activeHits.length * 8) +
    Math.min(20, yearHits.length * 10));

  return { isKosoShinsotsu: ok, kosoHits, shinsotsuHits, activeHits, yearHits, score, reason: ok ? 'ok' : reason };
}

// ---- 企業名の抽出 ----
// タイトル末尾/先頭に付く定型（｜採用情報 / - 会社概要 / 【公式】 等）を落とす。
const TITLE_NOISE = /【[^】]*】|｜.*$|\|.*$|-\s*[^-]*$|―.*$|采用情報|採用情報|採用サイト|求人情報|会社概要|会社案内|募集要項|公式(サイト|ホームページ)?|新卒採用|高卒採用|トップページ|ホーム(ページ)?|オフィシャルサイト/g;
// 法人格を含む社名を本文/タイトルから拾う正規表現
const CORP_RE = /((?:株式会社|有限会社|合同会社|合資会社|合名会社)[一-龥぀-ゟ゠-ヿA-Za-z0-9ー・＆&]{1,30}|[一-龥぀-ゟ゠-ヿA-Za-z0-9ー・＆&]{1,30}(?:株式会社|有限会社|合同会社))/;

// タイトル文字列から社名候補を得る（法人格つきを最優先、無ければノイズ除去した先頭塊）。
function nameFromTitle(title) {
  if (!title) return '';
  const corp = title.match(CORP_RE);
  if (corp) return corp[1].trim();
  const cleaned = title.replace(TITLE_NOISE, '').replace(/\s{2,}/g, ' ').trim();
  // 区切りで分割し、最も社名らしい（法人格 or 2〜25字）断片
  const parts = title.split(/[｜|\-―–—:：/／]/).map((s) => s.trim()).filter(Boolean);
  const corpPart = parts.find((p) => CORP_RE.test(p));
  if (corpPart) return (corpPart.match(CORP_RE) || [corpPart])[0].trim();
  return (cleaned || parts[0] || '').slice(0, 30).trim();
}

/**
 * 会社ページのHTMLと構造化情報から企業名を決定する。
 * @param {{html?:string, orgName?:string, ogSiteName?:string, title?:string, snippet?:string}} o
 * @returns {{name:string, source:string}}  name が空なら抽出失敗
 */
function extractCompanyName({ html = '', orgName = '', ogSiteName = '', title = '', snippet = '' } = {}) {
  // 1) JSON-LD Organization.name（最も信頼できる）
  if (orgName && normCompanyName(orgName)) return { name: orgName.trim(), source: 'jsonld' };
  // 2) og:site_name
  let og = ogSiteName;
  if (!og && html) {
    const $ = cheerio.load(html);
    og = $('meta[property="og:site_name"]').attr('content') ||
         $('meta[name="og:site_name"]').attr('content') || '';
  }
  if (og) {
    const corp = og.match(CORP_RE);
    const cand = corp ? corp[1] : og.replace(TITLE_NOISE, '').trim();
    if (cand && normCompanyName(cand)) return { name: cand.trim(), source: 'og:site_name' };
  }
  // 3) <title> or 渡されたtitle
  let ttl = title;
  if (!ttl && html) { const $ = cheerio.load(html); ttl = $('title').first().text().trim(); }
  const fromTitle = nameFromTitle(ttl);
  if (fromTitle && normCompanyName(fromTitle)) return { name: fromTitle, source: 'title' };
  // 4) 本文/スニペットの法人格つき社名
  const bodyText = (html ? cheerio.load(html)('body').text() : '') + '\n' + snippet;
  const corp = bodyText.match(CORP_RE);
  if (corp && normCompanyName(corp[1])) return { name: corp[1].trim(), source: 'body' };
  return { name: '', source: '' };
}

module.exports = {
  classifyKoso, extractCompanyName, nameFromTitle,
  KOSO, SHINSOTSU, ACTIVE, GUIDE, yearSignals,
};
