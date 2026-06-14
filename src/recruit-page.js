'use strict';
// gBizINFO 等で得た「公式URL」から採用ページの有無を判定する（公開情報のみ）。
//  1) トップページの<a>から採用系リンク（採用/recruit/careers/新卒…）を探す
//  2) 見つからなければ定番パス（/recruit/ /careers/ /saiyo/ …）を少数だけ探査
//  3) 採用ページ本文から「新卒」言及・職種キーワードを軽く抽出
// 取得は全て polite.js 経由（robots遵守＋レート制限＋キャッシュ）。
const cheerio = require('cheerio');
const { politeGet } = require('./polite');

// 採用ページを示すアンカーの手がかり（リンクテキスト or href）
const RECRUIT_HINTS = ['採用', 'リクルート', 'recruit', 'careers', 'career', '求人', 'join us', 'jobs', '新卒', '中途', 'エントリー', 'entry'];
const STRONG_PATH = /(recruit|career|saiyo|job|entry)/i;
// トップに無い場合に試す定番パス（多すぎるとサイト負荷になるので絞る）
const COMMON_RECRUIT_PATHS = ['/recruit/', '/recruit', '/careers/', '/careers', '/saiyo/', '/recruit/newgraduate/', '/recruit/fresh/', '/saiyo/shinsotsu/'];

const SHINSOTSU_RE = /(新卒|新卒採用|新卒者|26卒|27卒|28卒|20\d{2}年卒|大学生|大学院生|既卒|第二新卒)/;
const JOB_KEYWORDS = ['エンジニア', '営業', '総合職', '技術職', '事務', '企画', 'デザイナー', '施工管理', '介護', '看護', '販売', 'マーケティング', 'コンサル'];

function findRecruitLinks(baseUrl, html) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const $ = cheerio.load(html);
  const scored = [];
  const seen = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    let u;
    try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) return;
    seen.add(key);
    const hay = (u.pathname + ' ' + ($(a).text() || '')).toLowerCase();
    let score = 0;
    for (const h of RECRUIT_HINTS) if (hay.includes(h.toLowerCase())) score += STRONG_PATH.test(u.pathname) ? 2 : 1;
    // 外部の採用媒体（リクナビ/マイナビ等）に飛ぶリンクも有力な手がかり
    if (/(rikunabi|mynavi|en-japan|doda|type\.jp|wantedly|green-japan|onecareer)/i.test(u.host)) score += 2;
    if (score > 0) scored.push({ url: key, score, external: u.host !== base.host });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// 採用ページ本文から新卒言及・職種を軽く抽出
function analyzeRecruitText(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ');
  const shinsotsu = SHINSOTSU_RE.test(text);
  const jobs = JOB_KEYWORDS.filter((k) => text.includes(k));
  return { shinsotsu, jobs };
}

// 公式URLから採用情報を判定。戻り値:
// { 採用ページ有無:'○'|'', 採用ページURL, 新卒言及:'○'|'', 職種, 外部媒体, 根拠 }
async function checkRecruitPage(officialUrl) {
  const out = { '採用ページ有無': '', '採用ページURL': '', '新卒言及': '', '職種': '', '外部採用媒体': '', '根拠': '' };
  if (!officialUrl) return out;
  let url = String(officialUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // 1) トップページ取得 → 採用リンク探索
  const top = await politeGet(url, { render: 'static' });
  if (!top || top.blocked || top.error || !top.html) {
    out['根拠'] = top && top.blocked ? 'robots-disallow' : 'top-fetch-failed';
    return out;
  }
  const links = findRecruitLinks(top.finalUrl || url, top.html);
  const internal = links.filter((l) => !l.external);
  const external = links.filter((l) => l.external);
  if (external.length) out['外部採用媒体'] = [...new Set(external.map((l) => new URL(l.url).host.replace(/^www\./, '')))].slice(0, 3).join('/');

  let recruitUrl = internal.length ? internal[0].url : '';
  let recruitHtml = '';

  // 2) 内部リンクが無ければ定番パスを少数だけ探査
  if (!recruitUrl) {
    const origin = new URL(top.finalUrl || url).origin;
    for (const p of COMMON_RECRUIT_PATHS) {
      const probe = await politeGet(origin + p, { render: 'static' });
      if (probe && probe.html && !probe.error && !probe.blocked) {
        // 200相当でHTMLが返り、本文に採用語があれば採用ページとみなす
        const $ = cheerio.load(probe.html);
        const t = $('body').text();
        if (/採用|recruit|career|求人|エントリー/i.test(t)) { recruitUrl = probe.finalUrl || (origin + p); recruitHtml = probe.html; break; }
      }
    }
  }

  if (recruitUrl) {
    out['採用ページ有無'] = '○';
    out['採用ページURL'] = recruitUrl;
    out['根拠'] = recruitHtml ? 'common-path' : (internal.length ? 'top-anchor' : 'external-only');
    // 本文解析（内部リンク先はここで取得）
    if (!recruitHtml) {
      const r = await politeGet(recruitUrl, { render: 'static' });
      if (r && r.html) recruitHtml = r.html;
    }
    if (recruitHtml) {
      const a = analyzeRecruitText(recruitHtml);
      out['新卒言及'] = a.shinsotsu ? '○' : '';
      out['職種'] = a.jobs.slice(0, 5).join('/');
    }
  } else if (external.length) {
    // 自社採用ページは見つからないが外部媒体リンクはある
    out['採用ページ有無'] = '○';
    out['採用ページURL'] = external[0].url;
    out['根拠'] = 'external-only';
  } else {
    out['根拠'] = 'no-recruit-link';
  }
  return out;
}

module.exports = { checkRecruitPage, findRecruitLinks, analyzeRecruitText };
