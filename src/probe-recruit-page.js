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
const { isFullName, isKnownSurname, isPlausiblePersonName, completeSurname } = require('./jp-names');
const { pageMatchesCompany } = require('./search');
const { validateHit } = require('./validate');
const cfg = require('./config');
const { geminiAvailable } = require('./gemini');
const { extractRecruiterFromText } = require('./recruiter');

// Geminiに投げる価値があるか。無料枠RPMが厳しいので「個人が登場する兆候」のあるページに限定する。
//  採用担当者紹介/スタッフ紹介/人事部長/採用責任者/採用ブログ/メッセージ等＝実名が載りやすいページ。
function geminiWorthCalling(text) {
  const t = String(text || '');
  return /(採用担当者紹介|採用スタッフ|スタッフ紹介|社員紹介|メンバー紹介|人事部長|人事本部長|人事担当者|採用責任者|採用担当者|採用ブログ|先輩社員|社員インタビュー|採用担当.{0,8}(メッセージ|より|から|です|紹介))/.test(t);
}

// 日本語の姓+名らしさ（extract.js と同じ字種定義。姓1〜4字＋任意空白＋名1〜5字）
const NAME = '([\\u4e00-\\u9fa5々]{1,4}[ \\u3000]?[\\u4e00-\\u9fa5々\\u3040-\\u309f\\u30a0-\\u30ffー]{1,5})';
// 採用/人事を示すロール語（抽出のアンカー）
const ROLE = '(?:人事部|人事課|人事グループ|人材戦略部|人材開発部?|人財開発部?|採用部|採用課|採用チーム|人事|採用スタッフ|採用担当スタッフ|採用担当者|採用責任者|採用担当|人事担当|タレント(?:アクイジション)?|HR|新卒採用|中途採用|採用)';
// 役職語（任意で氏名直前に挟まる）
const TITLE = '(?:部長|次長|課長|係長|主任|マネージャー|マネジャー|リーダー|チーフ|担当|責任者|ディレクター|室長|本部長)?';

// 採用ページ本文に頻出する表記を確度つきで列挙（上ほど強い＝自己名乗り/明示ラベル）。
//  allowSurnameOnly: 名が省略された姓のみの言及（「人事の山田です」）を許容するか。
//  global付き＝1ページ内の全候補を走査し、辞書を通る最初の人名を採る（先頭の誤マッチに引きずられない）。
function recruitPatterns() {
  return [
    // 採用スタッフ紹介の画像alt:「採用スタッフ 中川 広見 イメージ」「人材戦略部 黒田 亮介」← 構造的で確実
    { re: new RegExp('(?:採用スタッフ|採用担当スタッフ|採用メンバー|人材戦略部|人材開発部?|人財開発部?)[\\s　]+' + NAME + '(?![\\u4e00-\\u9fa5])', 'g'), conf: 0.78 },
    // 名乗り:「採用担当の山田です」「人事部の佐藤と申します」← 自己言及で最強。姓のみ可。
    { re: new RegExp(ROLE + 'の\\s*' + NAME + '\\s*(?:です|と申します|と申し上げ|が担当|でございます)', 'g'), conf: 0.82, allowSurnameOnly: true },
    // ラベル+氏名:「人事部 採用担当：山田 太郎」「採用担当 山田太郎」「採用担当 佐々木・粟津」(姓のみ・中黒連結可)
    { re: new RegExp(ROLE + '\\s*' + TITLE + '\\s*[:：\\-―—|｜／/]?\\s*' + NAME + '(?![\\u4e00-\\u9fa5])', 'g'), conf: 0.7, allowSurnameOnly: true },
    // 氏名+（ロール）:「山田 太郎（採用担当）」「佐藤花子(人事部)」
    { re: new RegExp(NAME + '\\s*[（(]\\s*' + ROLE + '[^）)]{0,10}[）)]', 'g'), conf: 0.74 },
    // 署名ブロック:「人事部　山田 太郎」「新卒採用担当 佐々木」改行/全角空白区切り（姓のみ可・強アンカー）
    { re: new RegExp('(?:人事部|採用担当|新卒採用担当|人事|採用)[\\s　]+' + NAME + '(?:[\\s　・･、,／/]|$)', 'g'), conf: 0.62, allowSurnameOnly: true },
    // 「担当者：山田太郎」「採用担当者：田中」（前後に採用/人事文脈がある場合のみ採点で生かす・姓のみ可）
    { re: new RegExp('(?:採用|応募|お問[い合]*せ?)[^。\\n]{0,12}担当者?\\s*[:：]\\s*' + NAME, 'g'), conf: 0.6, allowSurnameOnly: true },
  ];
}

// HTMLから可視テキスト（script/style/nav除去、空白圧縮）
function visibleText(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg').remove();
  return $('body').text().replace(/[\t\r\n]+/g, '\n').replace(/[ 　]{2,}/g, ' ').trim();
}

// 画像alt・title・aria-label等の属性テキスト（採用スタッフ名は本文でなくalt属性に入ることが多い）。
function attrText(html) {
  const $ = cheerio.load(html);
  const parts = [];
  $('img[alt], [title], [aria-label]').each((_, el) => {
    for (const a of ['alt', 'title', 'aria-label']) {
      const v = $(el).attr(a);
      if (v && v.trim()) parts.push(v.trim());
    }
  });
  return [...new Set(parts)].join('\n');
}

// 抽出に渡す全文コーパス（可視テキスト＋属性テキスト）。本文に無くてもalt属性の氏名を拾える。
function pageCorpus(html) {
  return visibleText(html) + '\n' + attrText(html);
}

// 1ページ本文から最有力の採用担当者候補を1名抽出（無ければ null）。
//  各パターンを全マッチ走査し、姓ガゼッティアを通る最初の人名を採用（一般名詞の誤マッチを姓辞書で排除）。
function extractFromRecruitText(text) {
  if (!text || text.length < 40) return null;
  for (const { re, conf, allowSurnameOnly } of recruitPatterns()) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // 中黒/読点/スラッシュで複数担当者が連結される例「佐々木・粟津」「佐藤、鈴木」→ 先頭の1名に正規化。
      const raw = (m[1] || '').trim().split(/[・･、,／/]/)[0].trim();
      // 候補を確度順に作る: ①姓+名のフルネーム ②先頭漢字連を完全一致姓として(姓のみ・末尾助詞かなを除去)。
      // SME頻出の「採用担当：田中」「新卒採用担当 佐々木」を救いつつ、「田中 まで」の助詞glueを姓へ正規化。
      const cands = [];
      if (isFullName(raw)) cands.push(raw.replace(/[ 　]+/g, ' '));
      if (allowSurnameOnly) {
        const head = (raw.match(/^[一-龥々]{2,4}/) || [])[0] || '';
        const sur = head && completeSurname(head);
        if (sur) cands.push(sur);
      }
      // 一般名詞語ブロック（extract.js）で最終フィルタ。不合格なら1文字進めて再走査。
      let name = '';
      for (const c of cands) { if (looksLikePersonName(c.replace(/[ 　]/g, ''))) { name = c; break; } }
      if (!name) { re.lastIndex = m.index + 1; continue; }
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
  // 既定で深め(6面)。氏名は「採用スタッフ紹介/メンバー/インタビュー/メッセージ」面に濃いので深追いする。
  const maxPages = opts.maxPages || 6;
  if (!officialUrl) return null;
  let url = String(officialUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const top = await politeGet(url, { render: 'static' });
  if (!top || top.blocked || top.error || !top.html) return null;
  const baseUrl = top.finalUrl || url;

  // 取得対象ページ: トップ自身 + 内部採用リンク上位 + 採用直下の氏名濃い定番面（staff/member/interview/message/people）。
  const links = findRecruitLinks(baseUrl, top.html).filter((l) => !l.external).map((l) => l.url);
  let origin = ''; try { origin = new URL(baseUrl).origin; } catch (_) {}
  // 採用リンクが取れていれば、その配下に氏名濃い定番サブパスを増設（リンククリック相当の深掘り）。
  const recruitBases = [];
  for (const l of links.slice(0, 2)) { try { recruitBases.push(new URL(l).toString().replace(/\/+$/, '')); } catch (_) {} }
  const NAME_SUBPATHS = ['/staff', '/staff/', '/member', '/member/', '/members/', '/people/',
    '/interview', '/interview/', '/interviews/', '/message', '/message/', '/voice/', '/cross-talk/'];
  const deepPaths = [];
  for (const b of recruitBases) for (const sp of NAME_SUBPATHS) deepPaths.push(b + sp);
  const fallback = origin
    ? [origin + '/recruit/staff/', origin + '/recruit/member/', origin + '/recruit/interview/',
       origin + '/recruit/message/', origin + '/company/', origin + '/about/']
    : [];
  const candidates = [...new Set([baseUrl, ...links, ...deepPaths, ...fallback])].slice(0, maxPages);

  // 先に採用リンク先（=候補配列の2件目以降）を見て、最後にトップ。採用ページの方が氏名が濃い。
  const order = candidates.length > 1 ? [...candidates.slice(1), candidates[0]] : candidates;

  // Geminiフォールバック用に、最も有力な採用ページのコーパスを1つ保持しておく
  const useGemini = opts.gemini != null ? opts.gemini : geminiAvailable(cfg);
  let bestCorpus = null, bestUrl = null;

  for (const pageUrl of order) {
    let html = pageUrl === baseUrl ? top.html : null;
    if (!html) {
      const r = await politeGet(pageUrl, { render: 'static' });
      if (!r || r.blocked || r.error || !r.html) continue;
      html = r.html;
    }
    const corpus = pageCorpus(html);
    // 社名ゲート: 入力の公式URLが誤っている場合（例: 「東洋電機」に toyo.ac.jp）に
    // 無関係な会社の氏名を拾わないよう、社名がページに出る面でのみ氏名を採る。
    if (opts.companyName && !pageMatchesCompany(opts.companyName, '', visibleText(html))) continue;
    // Gemini価値ありの兆候があるページを優先保持（個人名が載りやすい採用スタッフ紹介系）。
    if (!bestCorpus && geminiWorthCalling(corpus)) { bestCorpus = corpus; bestUrl = pageUrl; }

    const hit = extractFromRecruitText(corpus);
    if (!hit) continue;
    // 検証ゲート（人名らしさ＋ロール語＋しきい値）＋最終人名ゲート（英字略称/地名/文断片を排除）。
    const v = validateHit({ ...hit }, {});
    if (!v.hit || !isPlausiblePersonName(hit.name)) continue;
    return {
      name: hit.name, role: hit.role || '', department: hit.department || '',
      confidence: hit.confidence, evidence: hit.evidence,
      sourceUrl: pageUrl, source: '自社採用ページ', engine: 'regex',
    };
  }

  // 正規表現が全ページで外れた場合のみ、最有力ページのコーパスをGeminiに1回投げる（レイアウト依存の氏名対策）
  if (useGemini && bestCorpus) {
    try {
      const g = await extractRecruiterFromText(bestCorpus, { name: opts.companyName || '' }, cfg);
      if (g && g.engine === 'gemini' && g.name && isPlausiblePersonName(g.name)) {
        return {
          name: g.name, role: g.role || '', department: g.department || '',
          confidence: g.confidence || 0.7, evidence: g.evidence || '',
          sourceUrl: bestUrl, source: '自社採用ページ', engine: 'gemini',
        };
      }
    } catch (_) { /* Gemini失敗時は無視（正規表現で取れなかった社として扱う） */ }
  }
  return null;
}

module.exports = { probeRecruitPage, extractFromRecruitText, visibleText, attrText, pageCorpus };
