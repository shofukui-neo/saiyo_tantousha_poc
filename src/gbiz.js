'use strict';
// L2: gBizINFO REST API アダプタ（GBIZ_TOKEN がある時だけ有効）。
//  - gbizSearch: 業種×地域などの条件で候補企業を検索（ページネーション・従業員数つき）
//  - gbizGet   : 法人番号で1社の代表者名/HP/属性を取得
// トークン未設定なら gbizAvailable()=false で、呼び出し側はローカル経路へフォールバックする。
const cfg = require('./config');

function gbizAvailable(c = cfg) { return !!(c && c.GBIZ_TOKEN); }

async function gbizFetch(url, c) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), c.PER_PAGE_TIMEOUT_MS || 15000);
  try {
    const res = await fetch(url, {
      headers: { 'X-hojinInfo-api-token': c.GBIZ_TOKEN, 'Accept': 'application/json' },
      signal: ctrl.signal, redirect: 'follow',
    });
    return res;
  } finally { clearTimeout(t); }
}

// 文字列/日付から西暦4桁を抽出（"1995-04-01" / "1995年" → "1995"）
function extractYear(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/(\d{4})/);
  return m ? m[1] : '';
}

// gBizINFO の hojin-info を共通形へ正規化
function normalizeHojin(info) {
  const emp = (function () {
    const e = info.employee_number != null ? info.employee_number : info.employees;
    const n = parseInt(e, 10);
    return Number.isNaN(n) ? null : n;
  })();
  return {
    corporateNumber: info.corporate_number || info.corporateNumber || '',
    name: info.name || '',
    representativeName: info.representative_name || '',
    websiteUrl: info.company_url || '',
    prefecture: info.location || info.prefecture_name || '',
    employees: emp,
    businessSummary: info.business_summary || '',
    businessItems: Array.isArray(info.business_items) ? info.business_items : [],
    establishmentYear: extractYear(info.date_of_establishment) || (info.founding_year || ''),
    updateDate: info.update_date || '',
  };
}

/**
 * 業種キーワードフィルタ（事業概要＋営業品目への部分一致・OR）。
 * GAS Layer1.5 の INDUSTRY_KEYWORDS フィルタを純ロジック化。
 * @param {object} h 正規化済み候補（businessSummary / businessItems を見る）
 * @param {string[]} keywords 業種キーワード。空なら無効（常に通過）。
 * @param {boolean} keepWhenNoData 事業概要・営業品目が空のとき残すか
 * @returns {{keep:boolean, matchedKw:string}}
 */
function matchIndustry(h, keywords, keepWhenNoData) {
  if (!keywords || !keywords.length) return { keep: true, matchedKw: '' };
  const hay = ((h.businessSummary || '') + ' ' + ((h.businessItems || []).join(' '))).trim();
  if (!hay) return { keep: !!keepWhenNoData, matchedKw: '' };
  const hit = keywords.find(function (kw) { return kw && hay.indexOf(kw) >= 0; });
  return hit ? { keep: true, matchedKw: hit } : { keep: false, matchedKw: '' };
}

/**
 * 設立からの経過年数フィルタ（新卒採用の継続性シグナル）。
 * @param {string|number} establishmentYear 設立年（西暦4桁）
 * @param {number} minYears 最低経過年数。0/未指定で無効。
 * @param {number} [nowYear] 現在年（テスト用に注入可）
 * @returns {boolean} 残すなら true
 */
function passesEstablishment(establishmentYear, minYears, nowYear) {
  if (!minYears || minYears <= 0 || !establishmentYear) return true;
  const y = nowYear || (new Date()).getFullYear();
  return (y - Number(establishmentYear)) >= minYears;
}

/**
 * 条件検索（1ページ）。
 * @param {object} params {name, prefecture, city, businessItem, corporateType, page, limit}
 * @returns {Promise<Array>} 正規化済み候補
 */
async function gbizSearch(params = {}, c = cfg) {
  if (!gbizAvailable(c)) return [];
  const q = [];
  if (params.name) q.push('name=' + encodeURIComponent(params.name));
  if (params.prefecture) q.push('prefecture=' + encodeURIComponent(params.prefecture));
  if (params.city) q.push('city=' + encodeURIComponent(params.city));
  if (params.businessItem) q.push('business_item=' + encodeURIComponent(params.businessItem));
  if (params.corporateType) q.push('corporate_type=' + encodeURIComponent(params.corporateType));
  // 従業員数レンジ（データ充実企業の絞り込みに有効。代表者名/HP保有率が大幅に上がる）
  if (params.employeeFrom != null && params.employeeFrom !== '') q.push('employee_number_from=' + encodeURIComponent(params.employeeFrom));
  if (params.employeeTo != null && params.employeeTo !== '') q.push('employee_number_to=' + encodeURIComponent(params.employeeTo));
  if (params.foundedYearFrom != null && params.foundedYearFrom !== '') q.push('founded_year=' + encodeURIComponent(params.foundedYearFrom));
  if (params.source) q.push('source=' + encodeURIComponent(params.source)); // 4=補助金採択等の情報源で絞り込み
  q.push('page=' + encodeURIComponent(params.page || 1));
  q.push('limit=' + encodeURIComponent(params.limit || c.GBIZ_LIMIT));
  const url = c.GBIZ_BASE + '?' + q.join('&');
  let res;
  try { res = await gbizFetch(url, c); } catch (_) { return []; }
  if (!res) return [];
  const code = res.status;
  if (code === 404) return [];          // 該当なし＝このページで打ち止め
  if (code >= 400) return [];
  try {
    const arr = (JSON.parse(await res.text())['hojin-infos']) || [];
    return arr.map(normalizeHojin);
  } catch (_) { return []; }
}

/**
 * 法人番号で1社取得（代表者名・HP・属性）。
 * @returns {Promise<object|null>}
 */
async function gbizGet(corporateNumber, c = cfg) {
  if (!gbizAvailable(c) || !corporateNumber) return null;
  const url = c.GBIZ_BASE + '/' + encodeURIComponent(corporateNumber);
  let res;
  try { res = await gbizFetch(url, c); } catch (_) { return null; }
  if (!res || res.status >= 400) return null;
  try {
    const arr = (JSON.parse(await res.text())['hojin-infos']) || [];
    return arr.length ? normalizeHojin(arr[0]) : null;
  } catch (_) { return null; }
}

/**
 * 補助金採択企業の法人番号セットを取得（source=4 で追加検索し突合用に集める）。
 * GAS Layer1.5 の ENRICH_SUBSIDY_FLAG 相当。トークン未設定なら空セット。
 * @param {object} params {prefecture, businessItem, corporateType}
 * @returns {Promise<Set<string>>}
 */
async function gbizSubsidyNumbers(params = {}, c = cfg) {
  const set = new Set();
  if (!gbizAvailable(c)) return set;
  for (let page = 1; page <= (c.GBIZ_PAGES_PER_QUERY || 5); page++) {
    const hits = await gbizSearch(Object.assign({}, params, { source: '4', page, limit: c.GBIZ_LIMIT }), c);
    if (!hits.length) break;
    hits.forEach(function (h) { if (h.corporateNumber) set.add(String(h.corporateNumber)); });
    if (hits.length < c.GBIZ_LIMIT) break; // 最終ページ
  }
  return set;
}

module.exports = {
  gbizAvailable, gbizSearch, gbizGet, normalizeHojin, gbizSubsidyNumbers,
  extractYear, matchIndustry, passesEstablishment,
};
