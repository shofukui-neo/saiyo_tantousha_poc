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
// 強アンカー（姓のみ許容に使う明示ロール）。bare 採用/人事/新卒採用 は弱く、地名/業種語(岡山/林業)を姓と誤認するため除外。
const STRONG_ROLE = '(?:人事部|人事課|人事グループ|人材戦略部|人材開発部?|人財開発部?|採用部|採用課|採用チーム|採用スタッフ|採用担当スタッフ|採用担当者|採用責任者|採用担当|新卒採用担当|人事担当)';
// 役職語（任意で氏名直前に挟まる）
const TITLE = '(?:部長|次長|課長|係長|主任|マネージャー|マネジャー|リーダー|チーフ|担当|責任者|ディレクター|室長|本部長)?';

// 採用ページ本文に頻出する表記を確度つきで列挙（上ほど強い＝自己名乗り/明示ラベル）。
//  allowSurnameOnly: 名が省略された姓のみの言及（「人事の山田です」）を許容するか。
//  global付き＝1ページ内の全候補を走査し、辞書を通る最初の人名を採る（先頭の誤マッチに引きずられない）。
function recruitPatterns() {
  return [
    // 採用/人事ロール近傍の「漢字（よみがな）」＝人名確定（辞書外姓も可）。例「人事総務部 栗城（クリキ）宛」
    // furiganaフラグで、姓辞書照合をスキップし isPlausiblePersonName のみで採用（読み仮名が人名性を保証）。
    { re: new RegExp(ROLE + '[^。\\n]{0,12}?([一-龥々]{2,4})\\s*[（(][ぁ-んァ-ヶー]{2,10}[）)]', 'g'), conf: 0.8, furigana: true },
    // 採用スタッフ紹介の画像alt:「採用スタッフ 中川 広見 イメージ」「人材戦略部 黒田 亮介」← 構造的で確実
    { re: new RegExp('(?:採用スタッフ|採用担当スタッフ|採用メンバー|人材戦略部|人材開発部?|人財開発部?)[\\s　]+' + NAME + '(?![\\u4e00-\\u9fa5])', 'g'), conf: 0.78 },
    // 名乗り:「採用担当の山田です」「人事部の佐藤と申します」← 自己言及で最強。姓のみ可。
    { re: new RegExp(ROLE + 'の\\s*' + NAME + '\\s*(?:です|と申します|と申し上げ|が担当|でございます)', 'g'), conf: 0.82, allowSurnameOnly: true },
    // ラベル+氏名(強ロール・姓のみ可):「人事部 採用担当：山田 太郎」「採用担当 佐々木・粟津」← 強アンカーのみ姓許容
    { re: new RegExp(STRONG_ROLE + '\\s*' + TITLE + '\\s*[:：\\-―—|｜／/]?\\s*' + NAME + '(?![\\u4e00-\\u9fa5])', 'g'), conf: 0.7, allowSurnameOnly: true },
    // ラベル+氏名(弱ロール・フルネーム必須):「新卒採用 山田太郎」← bare採用/人事は姓のみ不可（岡山/林業誤認防止）
    { re: new RegExp(ROLE + '\\s*' + TITLE + '\\s*[:：\\-―—|｜／/]?\\s*' + NAME + '(?![\\u4e00-\\u9fa5])', 'g'), conf: 0.66 },
    // 氏名+（ロール）:「山田 太郎（採用担当）」「佐藤花子(人事部)」
    { re: new RegExp(NAME + '\\s*[（(]\\s*' + ROLE + '[^）)]{0,10}[）)]', 'g'), conf: 0.74 },
    // 署名ブロック(強ロール・姓のみ可):「人事部　山田 太郎」「新卒採用担当 佐々木」改行/全角空白区切り
    { re: new RegExp(STRONG_ROLE + '[\\s　]+' + NAME + '(?:[\\s　・･、,／/]|$)', 'g'), conf: 0.62, allowSurnameOnly: true },
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
  for (const { re, conf, allowSurnameOnly, furigana } of recruitPatterns()) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // 中黒/読点/スラッシュで複数担当者が連結される例「佐々木・粟津」「佐藤、鈴木」→ 先頭の1名に正規化。
      // さらに末尾に貼り付く助詞語（〜まで/〜より/〜宛 等）を剥がす（「田中 まで」→「田中」）。
      const raw = (m[1] || '').trim().split(/[・･、,／/]/)[0]
        .replace(/[ 　]?(まで|までに|より|から|など|宛て?|行|の方|あて)$/, '').trim();
      let name = '';
      if (furigana) {
        // 読み仮名付き＝人名確定。姓辞書を介さず人名ゲートのみで採用（辞書外姓 栗城 等を救う）。
        if (raw && isPlausiblePersonName(raw)) name = raw;
      } else {
        // 候補を確度順に作る: ①姓+名のフルネーム ②先頭漢字連を完全一致姓として(姓のみ・末尾助詞かなを除去)。
        // SME頻出の「採用担当：田中」「新卒採用担当 佐々木」を救いつつ、「田中 まで」の助詞glueを姓へ正規化。
        const cands = [];
        if (isFullName(raw)) cands.push(raw.replace(/[ 　]+/g, ' '));
        if (allowSurnameOnly) {
          const head = (raw.match(/^[一-龥々]{2,4}/) || [])[0] || '';
          const sur = head && completeSurname(head);
          if (sur) cands.push(sur);
        }
        // 一般名詞語ブロック（extract.js）で最終フィルタ。
        for (const c of cands) { if (looksLikePersonName(c.replace(/[ 　]/g, ''))) { name = c; break; } }
      }
      // 不合格なら1文字進めて再走査（貪欲照合がロール語を偽氏名として食うのを防ぐ）。
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
// 採用ページ内の「氏名が濃い」内部リンク（staff/member/interview/message/people/採用担当/挨拶/entry）を
// アンカー語・パスから優先度つきで抽出。2段目以降のリンククリック相当の深掘りに使う。
function nameBearingLinks(baseUrl, html) {
  let base; try { base = new URL(baseUrl); } catch { return []; }
  const $ = cheerio.load(html);
  const out = []; const seen = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href'); if (!href) return;
    let u; try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || u.host !== base.host) return;  // 同一サイト内のみ
    u.hash = '';
    const key = u.toString(); if (seen.has(key)) return; seen.add(key);
    const hay = (decodeURIComponent(u.pathname) + ' ' + ($(a).text() || '')).toLowerCase();
    let score = 0;
    if (/staff|member|people|採用担当|担当者|スタッフ|メンバー|社員紹介|先輩/i.test(hay)) score += 3;
    if (/interview|インタビュー|message|メッセージ|挨拶|voice|声|対談|cross-?talk|座談/i.test(hay)) score += 2;
    if (/entry|エントリー|応募|contact|問い?合わせ|recruit|採用/i.test(hay)) score += 1;
    if (score > 0) out.push({ url: key, score });
  });
  out.sort((a, b) => b.score - a.score);
  return out.map((x) => x.url);
}

async function probeRecruitPage(officialUrl, opts = {}) {
  // 既定で深め(最大10面)。氏名は「採用スタッフ紹介/メンバー/インタビュー/メッセージ」面に濃いので、
  // 採用ページ内のリンクを2段目まで辿って深追いする（ユーザー要望「リンククリック後まで入念に探索」）。
  const maxPages = opts.maxPages || 10;
  if (!officialUrl) return null;
  let url = String(officialUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // 既定はstatic（高速）。IT/SPAサイトは render:'auto' で本文薄ければPlaywrightへエスカレーション。
  const render = opts.render || 'static';
  const top = await politeGet(url, { render });
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

  // BFS: 採用リンク先を先に、トップは最後に。各ページから氏名濃い2段目リンクを発見してキューに追加（予算 maxPages）。
  const useGemini = opts.gemini != null ? opts.gemini : geminiAvailable(cfg);
  let bestCorpus = null, bestUrl = null;
  const visited = new Set();
  const queue = [...new Set([...links, ...deepPaths, ...fallback, baseUrl])];
  let fetches = 0;

  while (queue.length && fetches < maxPages) {
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    let html = pageUrl === baseUrl ? top.html : null;
    if (!html) {
      const r = await politeGet(pageUrl, { render });
      if (!r || r.blocked || r.error || !r.html) continue;
      html = r.html;
    }
    fetches++;
    const corpus = pageCorpus(html);
    // 社名ゲート: 入力の公式URLが誤っている場合（例: 「東洋電機」に toyo.ac.jp）に
    // 無関係な会社の氏名を拾わないよう、社名がページに出る面でのみ氏名を採る。
    if (opts.companyName && !pageMatchesCompany(opts.companyName, '', visibleText(html))) continue;
    // Gemini価値ありの兆候があるページを優先保持（個人名が載りやすい採用スタッフ紹介系）。
    if (!bestCorpus && geminiWorthCalling(corpus)) { bestCorpus = corpus; bestUrl = pageUrl; }

    // このページから氏名濃い内部リンク（2段目）を発見してキュー前方に追加（予算内で深掘り）。
    if (queue.length + fetches < maxPages + 6) {
      for (const lk of nameBearingLinks(pageUrl, html).slice(0, 4)) {
        if (!visited.has(lk) && !queue.includes(lk)) queue.push(lk);
      }
    }

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
