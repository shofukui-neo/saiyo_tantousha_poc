'use strict';
/**
 * 求人媒体サイトの浅い巡回と、リンクの分類（企業公式サイト行き / 媒体内の深掘り先）。
 *
 * 背景: 媒体ページ自体に採用担当者の個人名が出るのはごく一部の媒体だけで、
 *       大半は媒体がリンクする「企業サイト側」に名前がある。よって
 *       「媒体を浅く巡回 → 外部の企業公式URLを集める」処理はどの媒体経路でも共通になる。
 *       harvest-all-media.js（本番ハーベスト）と experiment-nonmynavi-names.js（実測プローブ）が
 *       同じ巡回を各自に持っていたため、ここへ集約した。
 *
 * リンク分類（classifyLink）はネットワーク不要の純関数＝テスト対象。
 * 巡回（crawlMedia）は politeGet 経由なので robots/レート/キャッシュを必ず守る。
 */
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { registrableDomain } = require('./fetch');
const { isExcludedDomain } = require('./search');
const { hostOf } = require('./cli-util');

/** 媒体内で深掘りする価値のあるパス（企業一覧/詳細/スカウト等）のヒント。 */
const LISTING_HINT = /(company|companies|corp|kigyo|kaisha|会社|企業|一覧|list|search|result|area|pref|地域|業種|category|page=|recruit|job|member|参加|掲載|scout|offer|detail|show)/i;
/** 個人名が眠りやすい「詳細/メンバー/インタビュー」寄りのヒント（実測プローブ用）。 */
const DETAIL_HINT = /(company|companies|corp|kigyo|kaisha|会社|企業|detail|show|scout|offer|member|people|人|担当|recruit|job|jobs|posting|internship|event|セミナー|説明会|interview|インタビュー|\/id\/|\/\d{3,})/i;

/**
 * リンクを分類する（純関数）。
 * @param {string} absUrl     絶対URL
 * @param {string} mediaHost  媒体のホスト（www除去済み。hostOf() の戻り値）
 * @returns {{kind:'company'|'internal'|'excluded'|'invalid', host:string, reg:string}}
 *   company  = 外部かつ除外リスト外＝企業公式サイト候補
 *   internal = 媒体自身（サブドメイン含む）＝深掘り候補
 *   excluded = 求人媒体/SNS/企業DB等の既知除外ドメイン
 *   invalid  = URLとして解釈できない / http(s) でない
 */
function classifyLink(absUrl, mediaHost) {
  let u;
  try { u = new URL(absUrl); } catch { return { kind: 'invalid', host: '', reg: '' }; }
  if (!/^https?:$/.test(u.protocol)) return { kind: 'invalid', host: '', reg: '' };
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (mediaHost && (host === mediaHost || host.endsWith('.' + mediaHost) || mediaHost.endsWith('.' + host))) {
    return { kind: 'internal', host, reg: registrableDomain(host) };
  }
  if (isExcludedDomain(host)) return { kind: 'excluded', host, reg: registrableDomain(host) };
  return { kind: 'company', host, reg: registrableDomain(host) };
}

/** URLからフラグメント/クエリを落として正規化（訪問済み判定・重複排除のキー用）。 */
function cleanUrl(absUrl) { return String(absUrl).replace(/[#?].*$/, ''); }

/**
 * 媒体サイトを浅く巡回する。
 *
 * @param {string} startUrl 媒体トップ等の起点URL
 * @param {object} opts
 *   maxPages     {number}   取得する最大ページ数（既定10）
 *   internalHint {RegExp}   深掘りキューに積む媒体内パスの条件（既定 LISTING_HINT）
 *   onPage       {function} (page:{url,html,finalUrl}) 各ページ取得時のフック（氏名抽出等）
 *   onCompany    {function} ({url,host,reg,text}) 外部の企業候補リンクを見つけた時のフック
 * @returns {Promise<{pagesFetched:number, reachable:''|'yes'|'no', note:string, internalFound:number}>}
 *   reachable='no' は「1ページ目から取得できなかった（ブロック/到達不可）」を表す。
 */
async function crawlMedia(startUrl, opts) {
  const o = opts || {};
  const maxPages = o.maxPages || 10;
  const hint = o.internalHint || LISTING_HINT;
  const result = { pagesFetched: 0, reachable: '', note: '', internalFound: 0 };

  const mediaHost = hostOf(startUrl);
  if (!mediaHost) { result.note = 'bad-url'; return result; }

  const visited = new Set();
  const queue = [startUrl];
  while (queue.length && result.pagesFetched < maxPages) {
    const u = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);

    let page;
    try { page = await politeGet(u, { render: 'static' }); } catch { continue; }
    if (!page || page.blocked || page.error || !page.html) {
      if (result.pagesFetched === 0) {
        result.reachable = 'no';
        const why = page && (page.reason || page.error);
        result.note = why ? String(why).slice(0, 40) : 'blocked';
      }
      continue;
    }
    result.reachable = 'yes';
    result.pagesFetched++;

    const base = page.finalUrl || u;
    if (o.onPage) { try { o.onPage({ url: u, finalUrl: base, html: page.html }); } catch { /* フックの失敗で巡回は止めない */ } }

    const $ = cheerio.load(page.html);
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href');
      if (!href) return;
      let abs;
      try { abs = new URL(href, base).href; } catch { return; }
      const { kind, host, reg } = classifyLink(abs, mediaHost);
      if (kind === 'company') {
        if (!o.onCompany) return;
        const text = ($(a).text() || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        o.onCompany({ url: cleanUrl(abs), host, reg, text });
      } else if (kind === 'internal') {
        const next = cleanUrl(abs);
        const path = (() => { try { const x = new URL(abs); return x.pathname + x.search; } catch { return ''; } })();
        if (hint.test(path) && !visited.has(next) && queue.length < maxPages * 4) {
          result.internalFound++;
          queue.push(next);
        }
      }
    });
  }
  return result;
}

module.exports = { LISTING_HINT, DETAIL_HINT, classifyLink, cleanUrl, crawlMedia };
