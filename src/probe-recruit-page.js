'use strict';
// 採用担当者名プローブ①：自社採用ページからの氏名抽出（API不要・robots遵守）。
//  経路: 公式URL → トップの採用リンク発見(recruit-page.js の findRecruitLinks を再利用)
//        → 採用ページ本文を取得 → 採用ページに特化した正規表現で「採用担当者の氏名」を抽出。
//  既存 extract.js の汎用ヒューリスティックより、採用ページに頻出の表記
//  （「人事部 ○○」「○○（採用担当）」「採用担当の○○です」「採用担当 ○○ ○○」署名/名乗り）に強い。
//  戻り値は共通プローブ形 { name, role, department, confidence, evidence, sourceUrl, source }。
//  → 後で Wantedly / note・X / メール逆引き の各プローブも同じ形で足し、クロス検証に載せる。
const cheerio = require('cheerio');
const { politeGet } = require('./polite');
const { findRecruitLinks } = require('./recruit-page');
const { looksLikePersonName } = require('./extract');
const { isFullName, isKnownSurname } = require('./jp-names');
const { validateHit } = require('./validate');

// 日本語の姓+名らしさ（extract.js と同じ字種定義。姓1〜4字＋任意空白＋名1〜5字）
const NAME = '([\\u4e00-\\u9fa5々]{1,4}[ \\u3000]?[\\u4e00-\\u9fa5々\\u3040-\\u309f\\u30a0-\\u30ffー]{1,5})';
// 採用/人事を示すロール語（抽出のアンカー）
const ROLE = '(?:人事部|人事課|人事グループ|採用部|採用課|人事|採用担当者|採用責任者|採用担当|人事担当|人材開発|人財開発|タレント(?:アクイジション)?|HR|新卒採用|中途採用|採用)';
// 役職語（任意で氏名直前に挟まる）
const TITLE = '(?:部長|次長|課長|係長|主任|マネージャー|マネジャー|リーダー|チーフ|担当|責任者|ディレクター|室長|本部長)?';

// 採用ページ本文に頻出する表記を確度つきで列挙（上ほど強い＝自己名乗り/明示ラベル）。
//  allowSurnameOnly: 名が省略された姓のみの言及（「人事の山田です」）を許容するか。
//  global付き＝1ページ内の全候補を走査し、辞書を通る最初の人名を採る（先頭の誤マッチに引きずられない）。
function recruitPatterns() {
  return [
    // 名乗り:「採用担当の山田です」「人事部の佐藤と申します」← 自己言及で最強。姓のみ可。
    { re: new RegExp(ROLE + 'の\\s*' + NAME + '\\s*(?:です|と申します|と申し上げ|が担当|でございます)', 'g'), conf: 0.82, allowSurnameOnly: true },
    // ラベル+氏名:「人事部 採用担当：山田 太郎」「採用担当 山田太郎」
    { re: new RegExp(ROLE + '\\s*' + TITLE + '\\s*[:：\\-―—|｜／/]?\\s*' + NAME + '(?![\\u4e00-\\u9fa5])', 'g'), conf: 0.74 },
    // 氏名+（ロール）:「山田 太郎（採用担当）」「佐藤花子(人事部)」
    { re: new RegExp(NAME + '\\s*[（(]\\s*' + ROLE + '[^）)]{0,10}[）)]', 'g'), conf: 0.74 },
    // 署名ブロック:「人事部　山田 太郎」改行/全角空白区切り（役職語が直前に無くても可）
    { re: new RegExp('(?:人事部|採用担当|人事|採用)[\\s　]+' + NAME + '(?:[\\s　]|$)', 'g'), conf: 0.64 },
    // 「担当者：山田太郎」（前後に採用/人事文脈がある場合のみ採点で生かす）
    { re: new RegExp('(?:採用|応募|お問[い合]*せ?)[^。\\n]{0,12}担当者?\\s*[:：]\\s*' + NAME, 'g'), conf: 0.62 },
  ];
}

// HTMLから可視テキスト（script/style/nav除去、空白圧縮）
function visibleText(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg').remove();
  return $('body').text().replace(/[\t\r\n]+/g, '\n').replace(/[ 　]{2,}/g, ' ').trim();
}

// 1ページ本文から最有力の採用担当者候補を1名抽出（無ければ null）。
//  各パターンを全マッチ走査し、姓ガゼッティアを通る最初の人名を採用（一般名詞の誤マッチを姓辞書で排除）。
function extractFromRecruitText(text) {
  if (!text || text.length < 40) return null;
  for (const { re, conf, allowSurnameOnly } of recruitPatterns()) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = (m[1] || '').trim();
      // 二段ゲート: 一般名詞語ブロック（extract.js）＋姓辞書照合。
      // 不合格でも次の候補を取りこぼさないよう、マッチ先頭の1文字だけ進めて再走査する
      //（貪欲照合がロール語自体を偽の氏名として食い、真の氏名アンカーを飛び越すのを防ぐ）。
      const ok = name && looksLikePersonName(name) && (allowSurnameOnly ? isKnownSurname(name) : isFullName(name));
      if (!ok) { re.lastIndex = m.index + 1; continue; }
      const idx = m.index;
      const around = text.slice(Math.max(0, idx - 30), idx + m[0].length + 30);
      const role = (around.match(/(採用責任者|採用担当者|採用担当|人事担当|新卒採用|中途採用|人事部|採用部|人事|採用)/) || [])[0] || '';
      const dept = (around.match(/([一-龥]{2,8}部)/) || [])[0] || '';
      return { found: true, name, role, department: dept, evidence: m[0].trim().slice(0, 120), confidence: conf };
    }
  }
  return null;
}

// 公式URLから採用ページを特定し、本文から採用担当者名を抽出する。
// opts.maxPages: 取得上限（既定3＝トップ＋採用ページ＋会社概要）。戻り値は共通プローブ形 or null。
async function probeRecruitPage(officialUrl, opts = {}) {
  const maxPages = opts.maxPages || 3;
  if (!officialUrl) return null;
  let url = String(officialUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const top = await politeGet(url, { render: 'static' });
  if (!top || top.blocked || top.error || !top.html) return null;
  const baseUrl = top.finalUrl || url;

  // 取得対象ページ: トップ自身 + 内部採用リンク上位 +（保険で）/company /about
  const links = findRecruitLinks(baseUrl, top.html).filter((l) => !l.external).map((l) => l.url);
  let origin = ''; try { origin = new URL(baseUrl).origin; } catch (_) {}
  const fallback = origin ? [origin + '/company/', origin + '/about/'] : [];
  const candidates = [...new Set([baseUrl, ...links, ...fallback])].slice(0, maxPages);

  // 先に採用リンク先（=候補配列の2件目以降）を見て、最後にトップ。採用ページの方が氏名が濃い。
  const order = candidates.length > 1 ? [...candidates.slice(1), candidates[0]] : candidates;

  for (const pageUrl of order) {
    let html = pageUrl === baseUrl ? top.html : null;
    if (!html) {
      const r = await politeGet(pageUrl, { render: 'static' });
      if (!r || r.blocked || r.error || !r.html) continue;
      html = r.html;
    }
    const hit = extractFromRecruitText(visibleText(html));
    if (!hit) continue;
    // 検証ゲート（人名らしさ＋ロール語＋しきい値）を通ったものだけ確定
    const v = validateHit({ ...hit }, {});
    if (!v.hit) continue;
    return {
      name: hit.name,
      role: hit.role || '',
      department: hit.department || '',
      confidence: hit.confidence,
      evidence: hit.evidence,
      sourceUrl: pageUrl,
      source: '自社採用ページ',
    };
  }
  return null;
}

module.exports = { probeRecruitPage, extractFromRecruitText, visibleText };
