'use strict';
/**
 * 媒体の企業詳細ページから観測レコードを作る（純関数）
 * =====================================================================
 * 項目の抽出は既存の部品をそのまま使う:
 *   電話・従業員数   … scrape-base.extractCompanyFacts（phone.js の FAX窓・地域番号の検証込み）
 *   採用予定人数・卒年 … scrape-base.extractIntentSignals ＋ 募集人数の範囲表記（下限を採る）
 *   担当者名         … scrape-base.extractRecruiterName（人名辞書・非人名語ゲート込み）
 *   社名             … JSON-LD の Organization → 一覧のアンカー → og:title / h1 / title
 * 社名に法人格が無いページは捨てる（媒体の特集記事やカテゴリページを企業と取り違えないため）。
 */
const cheerio = require('cheerio');
const { extractCompanyFacts, extractIntentSignals, extractRecruiterName } = require('../scrape-base');
const { extractOrganization } = require('../structured');
const { mapIndustry } = require('./industry-map');
const { COMPANY_NAME_RE, sameSite } = require('./media-discover');
const { isExcludedDomain } = require('../search');

const PREFS = '北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県';
const PREF_NEAR_RE = new RegExp(`(?:本社|本店|所在地|住所|本社所在地)[^。]{0,20}?(${PREFS})`);
const HP_TEXT_RE = /(ホームページ|ＨＰ|HP|公式サイト|企業サイト|コーポレートサイト|会社サイト|企業HP|会社HP|^https?:\/\/)/i;
const HIRE_RE = /(?:採用予定人数|募集人数|採用人数|採用予定数)[^0-9０-９]{0,10}([0-9０-９]{1,4})\s*(?:[〜~～\-－]\s*[0-9０-９]{1,4})?\s*名/;
const INDUSTRY_RE = /(?:^|\n|\s)業種\s*[：:]?\s*([^\n／|｜]{2,30})/;
// 表やリストの項目の境目。cheerio の text() は <dt>業種</dt><dd>陸運業</dd> を「業種陸運業」とつなげてしまう
const BLOCK_END_RE = /<\/(dt|dd|th|td|li|p|div|tr|h[1-6]|section|article)>|<br\s*\/?>/gi;

// 社名の取り出し。タイトルやアンカーは「中尾 一輝さん 株式会社財宝 就職するなら…」
// 「山二システムサービス株式会社60分で…」のように飾りが前後に付くので、法人格の位置から社名だけを切り出す。
const PREFIX_FORMS = '株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|社会医療法人|医療法人社団|医療法人財団|医療法人|学校法人|特定非営利活動法人|NPO法人|農業協同組合';
const SUFFIX_FORMS = '株式会社|有限会社|合同会社|合資会社|合名会社';
const BODY = '[^\\s\\u3000、。,，|｜()（）「」『』【】\\[\\]<>＜＞!！?？:：/／]{1,30}?';
const BODY_GREEDY = '[^\\s\\u3000、。,，|｜()（）「」『』【】\\[\\]<>＜＞!！?？:：/／]{1,30}';
const PREFIX_RE = new RegExp(`(?:${PREFIX_FORMS})\\s?${BODY_GREEDY}`);
const SUFFIX_RE = new RegExp(`${BODY}(?:${SUFFIX_FORMS})`);
const ANY_FORM_RE = new RegExp(`(?:${PREFIX_FORMS})`, 'g');
// 末尾の飾り。「の会社概要」「の採用情報」「採用サイト」は削るが、接尾の「…株式会社」の「会社」は削らない。
const TAIL_NOISE_RE = /(?:[のの・](?:新卒|中途)?(?:採用|求人|会社|企業|インターン|説明会|募集|業界研究)(?:情報|概要|詳細|ページ|一覧|要項|データ|サイト)?|(?:新卒|中途)?(?:採用|求人|インターン|説明会|募集)(?:情報|概要|詳細|ページ|一覧|要項|データ|サイト))$/;

function corpNameIn(s) {
  const t = String(s || '')
    .replace(/[㈱]|[（(]株[)）]/g, '株式会社').replace(/[㈲]|[（(]有[)）]/g, '有限会社')
    .replace(/\s+/g, ' ');
  const p = t.match(PREFIX_RE);
  const q = t.match(SUFFIX_RE);
  // 文中で先に出る方を採る
  let m = p && (!q || p.index <= q.index) ? p[0] : q ? q[0] : '';
  if (!m) return '';
  // 「株式会社ウイズ・ワン株式会社ウイズ・ワン」のように法人格が2回出たら、2回目の手前で切る
  const forms = [...m.matchAll(ANY_FORM_RE)];
  if (forms.length > 1 && forms[1].index > 0) {
    const head = m.slice(0, forms[1].index);
    m = COMPANY_NAME_RE.test(head) && head.length > forms[0][0].length ? head : m.slice(forms[1].index);
  }
  // 「株式会社ブロンコビリーの新卒採用・就活情報」→ 社名の後ろの「の＋採用系の語」から先を落とす
  m = m.replace(/[のの](?:長期|短期|有給|1day|１day|オープン|夏|冬)?(?:新卒|採用|求人|就活|就職|会社|企業|インターン|説明会|中途|募集|業界研究|仕事|職場).*$/i, '');
  return m.replace(TAIL_NOISE_RE, '').trim();
}

/** タイトル類から社名を取り出す（法人格の無いものは空）。 */
function cleanCompanyName(raw) {
  const parts = String(raw || '').split(/\s*[|｜]\s*|\s+[-–—]\s+|【|】/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const n = corpNameIn(part);
    if (n && n.replace(new RegExp(`^(?:${PREFIX_FORMS})|(?:${SUFFIX_FORMS})$`, 'g'), '').length >= 1) return n.slice(0, 60);
  }
  return '';
}

const toHalf = (s) => String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

/**
 * @param {string} html 企業詳細ページ
 * @param {string} url  そのURL（根拠URL）
 * @param {{anchorName?:string, mediaName?:string}} hint
 * @returns {object|null} 観測レコードの素（社名が取れなければ null）
 */
function extractDetail(html, url, hint = {}) {
  const $ = cheerio.load(String(html || '').replace(BLOCK_END_RE, (tag) => tag + '\n'));
  $('script:not([type="application/ld+json"]),style,noscript').remove();
  const text = $('body').text().replace(/[ \t　]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const org = extractOrganization(html) || {};

  const name = [org.name, hint.anchorName, $('meta[property="og:title"]').attr('content'), $('h1').first().text(), $('title').text()]
    .map(cleanCompanyName).find(Boolean) || '';
  if (!name) return null;

  const facts = extractCompanyFacts({ html, text });
  const intent = extractIntentSignals(text);
  const hireM = text.match(HIRE_RE);
  const hire = hireM ? parseInt(toHalf(hireM[1]), 10) : (intent.採用予定人数 ? parseInt(intent.採用予定人数, 10) : null);
  const rec = extractRecruiterName(text);
  const prefM = text.match(PREF_NEAR_RE);
  const indM = text.match(INDUSTRY_RE);

  // 公式URL: 媒体の外へ出るリンクのうち、アンカーが「ホームページ」等のもの → JSON-LD の url
  let site = '';
  $('a[href]').each((_, a) => {
    if (site) return;
    const href = $(a).attr('href') || '';
    const t = $(a).text().replace(/\s+/g, ' ').trim();
    let abs; try { abs = new URL(href, url).href; } catch { return; }
    if (!/^https?:/.test(abs) || sameSite(abs, url)) return;
    let h = ''; try { h = new URL(abs).hostname; } catch { return; }
    if (isExcludedDomain(h)) return;
    if (HP_TEXT_RE.test(t)) site = abs.replace(/[?#].*$/, '');
  });
  if (!site && org.url && !sameSite(org.url, url)) site = org.url;

  const industryRaw = indM ? indM[1] : '';
  return {
    company_name: name,
    phone: facts.電話番号 || org.telephone || '',
    url: site,
    pref: prefM ? prefM[1] : '',
    industry_raw: industryRaw,
    industry: mapIndustry(industryRaw, name),
    employees: facts.従業員数 || null,
    hire_newgrad: Number.isFinite(hire) ? hire : null,
    // 「丸山 です」「田中と申します」のような名乗りの語尾を落とす
    recruiter_name: String(rec.name || '').replace(/s*(?:です|でした|と申します|が担当|まで)$/, '').trim(),
    recruiter_role: rec.role || '',
    recruiter_dept: rec.dept || '',
    evidence_url: url,
    extra: { 掲載媒体: hint.mediaName || '', 卒年: intent.卒年 || '', 募集職種: intent.募集職種 || '', メール: facts.メール || '' },
  };
}

/**
 * 媒体自身の代表番号を落とす。同じ電話番号が多くの企業ページに出るなら、それは媒体側の番号。
 * @param {object[]} observations 1媒体ぶん（その場で書き換える）
 */
function dropMediaPhones(observations) {
  const count = new Map();
  for (const o of observations) if (o.phone) count.set(o.phone, (count.get(o.phone) || 0) + 1);
  const limit = Math.max(3, Math.ceil(observations.length * 0.2));
  const shared = new Set([...count].filter(([, n]) => n >= limit).map(([p]) => p));
  for (const o of observations) if (shared.has(o.phone)) { o.extra.媒体側の番号として除外 = o.phone; o.phone = ''; }
  return [...shared];
}

module.exports = { extractDetail, cleanCompanyName, dropMediaPhones };
