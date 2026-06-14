'use strict';
// L2: 企業発掘（企業選定）の統合層。
//  - GBIZ_TOKEN があれば gBizINFO で「業種×地域」を構造化検索し、従業員数レンジで選別。
//  - 無ければ既存 discover.js（Bing検索）で ICP のキーワードから企業名を収集。
//  - opt.query / opt.listUrl が明示されていれば ICP より優先してそれを使う。
// いずれも共通の候補オブジェクト配列を返す:
//   { name, corporateNumber, domain, websiteUrl, representativeName, prefecture, employees, industry, icpScore, source }
const cfg = require('./config');
const { gbizAvailable, gbizSearch, gbizSubsidyNumbers, matchIndustry, passesEstablishment } = require('./gbiz');
const { discoverCompanies } = require('./discover');
const { companyCore } = require('./search');
const { normalizeDomain, discoveryIcpScore } = require('./score');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 重複キー（法人番号優先・無ければ社名コア）
function keyOf(c) {
  if (c.corporateNumber) return 'c:' + c.corporateNumber;
  const core = companyCore(c.name || '').toLowerCase();
  return 'n:' + core;
}

// ICP の geography（都道府県）正規化。「全国/日本」等は空（全国）扱い。
function prefList(icp) {
  let prefs = (icp.geography && icp.geography.length) ? icp.geography.slice(0) : [''];
  prefs = prefs.map((p) => (/全国|日本|全都道府県/.test(String(p)) ? '' : p));
  return prefs.length ? prefs : [''];
}

// ===== gBizINFO 発掘 =====
async function discoverViaGbiz(icp, target, c = cfg) {
  const prefs = prefList(icp);
  const inds = (icp.target_industries && icp.target_industries.length) ? icp.target_industries.slice(0) : [''];
  const queries = [];
  prefs.forEach((pref) => inds.forEach((ind) => queries.push({ pref, ind })));

  const empMin = c.ICP_EMP_MIN, empMax = c.ICP_EMP_MAX;
  const seen = new Set();
  const out = [];
  // 補助金採択フラグ用：都道府県ごとの法人番号セット（GBIZ_ENRICH_SUBSIDY 時のみ）
  const subsidyByPref = {};

  for (const Q of queries) {
    if (out.length >= target) break;
    // 補助金セットを都道府県単位で1回だけ取得（業種ループで使い回す）
    if (c.GBIZ_ENRICH_SUBSIDY && !(Q.pref in subsidyByPref)) {
      subsidyByPref[Q.pref] = await gbizSubsidyNumbers({
        prefecture: Q.pref, corporateType: c.GBIZ_CORPORATE_TYPE,
      }, c);
    }
    const subsidySet = subsidyByPref[Q.pref] || null;

    for (let page = 1; page <= c.GBIZ_PAGES_PER_QUERY && out.length < target; page++) {
      const hits = await gbizSearch({
        prefecture: Q.pref, businessItem: Q.ind,
        corporateType: c.GBIZ_CORPORATE_TYPE, page, limit: c.GBIZ_LIMIT,
      }, c);
      if (!hits.length) break; // この条件は取り切った
      for (const h of hits) {
        if (out.length >= target) break;
        if (!h.name) continue;
        // 業種KWフィルタ（事業概要＋営業品目への部分一致）。GBIZ_INDUSTRY_KEYWORDS 空なら通過。
        const im = matchIndustry(h, c.GBIZ_INDUSTRY_KEYWORDS, c.GBIZ_KEEP_WHEN_NO_INDUSTRY_DATA);
        if (!im.keep) continue;
        // 設立年フィルタ（新卒採用の継続性）。GBIZ_MIN_YEARS=0 なら通過。
        if (!passesEstablishment(h.establishmentYear, c.GBIZ_MIN_YEARS)) continue;

        const subsidy = subsidySet ? subsidySet.has(String(h.corporateNumber)) : false;
        const cand = {
          name: h.name, corporateNumber: h.corporateNumber || '',
          domain: normalizeDomain(h.websiteUrl), websiteUrl: h.websiteUrl || '',
          representativeName: h.representativeName || '',
          prefecture: h.prefecture || Q.pref || '', employees: h.employees,
          industry: im.matchedKw || Q.ind || h.businessSummary || '', source: 'gBizINFO',
          establishmentYear: h.establishmentYear || '',
          subsidy, subsidyFlag: subsidy ? '○' : '',
        };
        const k = keyOf(cand);
        if (seen.has(k)) continue;
        // ICPフィルタ：従業員数レンジ（不明は KEEP_UNKNOWN_EMP に従う）
        if (cand.employees != null) {
          if (cand.employees < empMin || cand.employees > empMax) continue;
        } else if (!c.KEEP_UNKNOWN_EMP) {
          continue;
        }
        cand.icpScore = discoveryIcpScore(cand, c);
        seen.add(k);
        out.push(cand);
      }
      await sleep(200);
    }
  }
  // ICPスコア降順で返す
  out.sort((a, b) => (b.icpScore || 0) - (a.icpScore || 0));
  return out.slice(0, target);
}

// ===== Bing 発掘（API不要・フォールバック）=====
async function discoverViaSearch(icp, deps, target, opt, c = cfg) {
  const names = [];
  const seen = new Set();
  const addNames = (arr) => {
    for (const n of arr || []) {
      const core = companyCore(n).toLowerCase();
      if (core && !seen.has(core)) { seen.add(core); names.push(n); }
    }
  };

  // 明示クエリ/一覧URLが最優先
  if (opt && (opt.query || opt.listUrl)) {
    const d = await discoverCompanies({ query: opt.query, listUrl: opt.listUrl, limit: target }, deps);
    addNames(d.names);
  } else {
    // ICP の 業種×地域 をキーワードへ展開して収集
    const prefs = (icp.geography && icp.geography.length) ? icp.geography : [''];
    const inds = (icp.target_industries && icp.target_industries.length) ? icp.target_industries : [''];
    const combos = [];
    prefs.forEach((p) => inds.forEach((i) => combos.push([p, i].filter(Boolean).join(' '))));
    if (!combos.length || combos.every((s) => !s)) {
      // ICP が空なら最低限のクエリ（業種未指定では収量が落ちる旨は呼び出し側で警告）
      combos.length = 0; combos.push(opt && opt.fallbackQuery ? opt.fallbackQuery : '企業 一覧');
    }
    for (const kw of combos) {
      if (names.length >= target) break;
      const remaining = target - names.length;
      const d = await discoverCompanies({ query: kw, limit: remaining }, deps);
      addNames(d.names);
    }
  }

  return names.slice(0, target).map((name) => ({
    name, corporateNumber: '', domain: '', websiteUrl: '',
    representativeName: '', prefecture: '', employees: null,
    industry: '', icpScore: null, source: 'search',
  }));
}

/**
 * 統合発掘。gBiz が使えれば構造化発掘、無ければ Bing 発掘。
 * @param {object} icp 正規化済みICP
 * @param {object} deps { fetchPage, extractText }
 * @param {object} opt { limit, query, listUrl, fallbackQuery }
 * @returns {Promise<{candidates:Array, source:string}>}
 */
async function discover(icp, deps = {}, opt = {}, c = cfg) {
  const target = opt.limit || c.DISCOVER_TARGET;
  if (gbizAvailable(c) && !(opt && (opt.query || opt.listUrl))) {
    const candidates = await discoverViaGbiz(icp, target, c);
    return { candidates, source: 'gBizINFO' };
  }
  const candidates = await discoverViaSearch(icp, deps, target, opt, c);
  return { candidates, source: 'search' };
}

module.exports = { discover, discoverViaGbiz, discoverViaSearch, keyOf };
