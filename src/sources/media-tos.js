'use strict';
/**
 * 媒体の利用規約チェック（収集してよいかの一次判定）
 * =====================================================================
 * 媒体トップから利用規約のページを探し、本文を文単位に切って次の2種類の禁止を探す。
 *   automated  … スクレイピング・クローリング・ロボット・自動的な取得や収集の禁止
 *   commercial … 掲載情報を営業・勧誘・宣伝などの目的に使うことの禁止
 * どちらかが「禁止」の語と同じ文に出たら prohibited（＝T3。収集しない）。
 * 規約ページが見つからなければ not-found（＝人が確認するまで収集しない）。
 *
 * これは機械的な一次判定で、法的な判断ではない。判定の根拠文を evidence に必ず残し、
 * 人が読んで覆すときは media.json の tos_override に結論と理由を書く（自動判定より優先）。
 */
const cheerio = require('cheerio');
const { politeGet } = require('../polite');

// 規約にあたるページの呼び名は媒体ごとに違う（マイナビ=サイトポリシー、かごJob=ご利用にあたって）。
// プライバシーポリシーは個人情報の扱いで、収集の可否は書かれないので含めない。
const TERMS_TEXT_RE = /(利用規約|ご利用規約|サイト利用規約|サービス利用規約|会員規約|利用条件|ご利用にあたって|ご利用について|サイトのご利用|サイトポリシー|サイトご利用|当サイトについて|このサイトについて|免責事項|著作権|terms\s*of\s*(use|service)|^terms$)/i;
const TERMS_PATHS = ['/terms', '/terms/', '/kiyaku', '/kiyaku/', '/kiyaku.html', '/terms.html', '/rule', '/rule/', '/agreement', '/terms-of-use', '/policy/terms', '/sitepolicy/', '/policy/'];

const PROHIBIT_RE = /(禁止|してはなら|行ってはなら|しないものと|行わないもの|禁じ|できません|不可)/;
const AUTOMATED_RE = /(スクレイピング|スクレーピング|クローリング|クローラ|ロボット|ボット|[^ァ-ヶ]bot|(自動|機械)(的|化)?[なにな]?[^。]{0,20}(手段|方法|プログラム|ツール|ソフト|取得|収集|抽出|ダウンロード|アクセス|複製)|プログラム[^。]{0,15}(取得|収集|抽出|アクセス))/i;
const COMMERCIAL_RE = /(営業|勧誘|宣伝|広告|商業|商用|販売促進)[^。]{0,25}(目的|利用|使用|行為)/;
// 「個人使用（非商用）のみに限りご利用いただけます」のような利用範囲の限定。「禁止」の語が無くても商用利用の禁止と同じ。
const NONCOMMERCIAL_ONLY_RE = /((個人|私的)(的な)?[^。]{0,6}(使用|利用)|非商用)[^。]{0,20}(のみ|に限り|に限っ|に限ら)/;
// 「以下の行為を禁止します。」の後に禁止行為が箇条書きで並ぶ形。項目の文には「禁止」の語が無い。
const LIST_HEAD_RE = /(禁止事項|(以下|次)[^。]{0,30}禁止)/;
const LIST_WINDOW = 2500; // 見出しから何文字先までを禁止行為の箇条書きとみなすか

/** 規約本文から禁止の文を探す（純関数）。 */
function scanTerms(text) {
  const sentences = String(text || '').replace(/\s+/g, ' ').split(/(?<=[。．\n])|(?=\s[0-9０-９]{1,2}[.．、)）])/);
  const hits = [];
  let listLeft = 0; // 箇条書きの禁止行為として読む残り文字数
  for (const s0 of sentences) {
    const s = s0.trim();
    if (!s) continue;
    const inList = listLeft > 0;
    listLeft = Math.max(0, listLeft - s.length);
    if (LIST_HEAD_RE.test(s)) listLeft = LIST_WINDOW;
    if (NONCOMMERCIAL_ONLY_RE.test(s)) { hits.push({ kind: 'commercial', text: s.slice(0, 160) }); continue; }
    if (!inList && !PROHIBIT_RE.test(s)) continue;
    if (AUTOMATED_RE.test(s)) hits.push({ kind: 'automated', text: s.slice(0, 160) });
    else if (COMMERCIAL_RE.test(s)) hits.push({ kind: 'commercial', text: s.slice(0, 160) });
  }
  return hits;
}

/** トップページのHTMLから規約ページの候補URLを探す（純関数）。 */
function findTermsLinks(html, baseUrl) {
  const $ = cheerio.load(html || '');
  const out = [];
  $('a[href]').each((_, a) => {
    const text = $(a).text().replace(/\s+/g, ' ').trim();
    if (!TERMS_TEXT_RE.test(text)) return;
    try { out.push(new URL($(a).attr('href'), baseUrl).href.replace(/#.*$/, '')); } catch {}
  });
  return [...new Set(out)];
}

const bodyText = (html) => { const $ = cheerio.load(html || ''); $('script,style,noscript').remove(); return $('body').text().replace(/\s+/g, ' ').trim(); };

/**
 * 媒体の利用規約を判定する（ネットワークあり）。
 * @returns {Promise<{verdict:'prohibited'|'no-explicit-prohibition'|'not-found', terms_url:string, evidence:object[]}>}
 */
async function checkTerms(topUrl, topHtml) {
  const origin = new URL(topUrl).origin;
  let links = findTermsLinks(topHtml, topUrl);
  if (!links.length) {
    // フッターをJSで描く媒体（あさがくナビ等）は描画したトップから探し直す
    const r = await politeGet(topUrl, { render: 'auto', noCache: true });
    if (r && r.html) links = findTermsLinks(r.html, r.finalUrl || topUrl);
  }
  const candidates = [...links, ...TERMS_PATHS.map((p) => origin + p)];
  // 規約らしいページを全部読む（サイトポリシーと会員規約が別ページの媒体がある）。どれか1つでも禁止があれば禁止。
  const read = [];
  const hits = [];
  for (const url of [...new Set(candidates)].slice(0, 8)) {
    const r = await politeGet(url, { render: 'static' });
    if (!r || !r.html) continue;
    let text = bodyText(r.html);
    // JS描画の規約ページ（本文がほぼ空）は描画して読み直す
    if (text.length < 300 && !r.blocked) {
      const r2 = await politeGet(url, { render: 'auto', noCache: true });
      if (r2 && r2.html) text = bodyText(r2.html);
    }
    if (text.length < 300 || !/(規約|禁止|利用者|ユーザー|会員|著作権|ご利用)/.test(text)) continue; // 規約らしくない
    read.push(url);
    hits.push(...scanTerms(text).map((h) => ({ ...h, url })));
    if (read.length >= 3) break;
  }
  if (!read.length) return { verdict: 'not-found', terms_url: '', evidence: [] };
  return { verdict: hits.length ? 'prohibited' : 'no-explicit-prohibition', terms_url: read.join(' '), evidence: hits.slice(0, 3) };
}

module.exports = { scanTerms, findTermsLinks, checkTerms, AUTOMATED_RE, COMMERCIAL_RE };
